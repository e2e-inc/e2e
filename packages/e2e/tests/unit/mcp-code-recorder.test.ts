/**
 * `run_code`'s recorder: the code calls the real objects through it, and each
 * call is written down as the test line that repeats it. A call that returns
 * at once is a step in a chain, one that returns a promise is a line, and a
 * line that failed with nothing waiting on it is what the call fails with.
 */

import { describe, expect, it } from 'vitest';
import { Recorder, type Outcome } from '../../src/session-tools/code-recorder.ts';

const sources = (outcomes: readonly Outcome[]): string[] => outcomes.map((outcome) => ('error' in outcome ? `failed: ${outcome.source}` : `${outcome.read ? 'read: ' : ''}${outcome.source}`));

interface FakeLocator {
  readonly path: string;
  nth(index: number): FakeLocator;
  filter(options: { readonly has: FakeLocator }): FakeLocator;
  tap(options?: object): Promise<void>;
  fill(value: unknown): Promise<void>;
  textContent(): Promise<string>;
  missing(): Promise<never>;
}

function fakeScreen(seen: unknown[] = []) {
  const locator = (path: string): FakeLocator => ({
    path,
    nth: (index) => locator(`${path}[${String(index)}]`),
    filter: ({ has }) => {
      seen.push(has);
      return locator(`${path}{${has.path}}`);
    },
    tap: () => Promise.resolve(),
    fill: (value) => {
      seen.push(value);
      return Promise.resolve();
    },
    textContent: () => Promise.resolve(`text of ${path}`),
    missing: () => Promise.reject(Object.assign(new Error('locator matched no nodes'), { code: 'LOCATOR_NOT_FOUND' })),
  });
  return { getByRole: (role: string, name?: string) => locator(name === undefined ? role : `${role}:${name}`) };
}

describe('run_code recorder', () => {
  it('spells each line as a test writes it, and tells a read from an action', async () => {
    const recorder = new Recorder();
    const screen = recorder.wrap(fakeScreen(), 'screen');
    const row = screen.getByRole('row').nth(2);
    await row.tap({ position: { x: 1, y: 2 }, modifiers: ['Shift'], skip: undefined });
    expect(await row.textContent()).toBe('text of row[2]');
    await screen.getByRole('textbox', "it's \\ a\nname").fill(/^a.b$/i);
    expect(sources(recorder.outcomes)).toEqual([
      "await screen.getByRole('row').nth(2).tap({ position: { x: 1, y: 2 }, modifiers: ['Shift'] });",
      "read: await screen.getByRole('row').nth(2).textContent();",
      "await screen.getByRole('textbox', 'it\\'s \\\\ a\\nname').fill(/^a.b$/i);",
    ]);
    expect(await recorder.end()).toEqual({ unawaited: 0, lost: undefined });
  });

  it('hands the real object what the code holds wrapped, and leaves the rest as it is', async () => {
    const seen: unknown[] = [];
    const recorder = new Recorder();
    const screen = recorder.wrap(fakeScreen(seen), 'screen');
    const secret = Object.freeze({ name: 'apiKey', [Symbol.for('brand')]: true });
    const secrets = recorder.wrap({ get: (_name: string) => secret }, 'secrets');
    await screen.getByRole('row').filter({ has: screen.getByRole('cell', 'Ada') }).fill(secrets.get('apiKey'));
    expect((seen[0] as FakeLocator).path).toBe('cell:Ada');
    expect(seen[1]).toBe(secret);
    expect(sources(recorder.outcomes)).toEqual(["await screen.getByRole('row').filter({ has: screen.getByRole('cell', 'Ada') }).fill(secrets.get('apiKey'));"]);
  });

  it('names an object a line resolved with, and calls a function of the code as the code wrote it', async () => {
    const recorder = new Recorder();
    const tab = { close: () => Promise.resolve() };
    const calls: unknown[] = [];
    const browser = recorder.wrap(
      Object.freeze({
        newTab: () => Promise.resolve(tab),
        evaluate: (script: () => number) => Promise.resolve(script()),
        route: (pattern: string, handler: (value: number) => number) => {
          calls.push(handler(20));
          return Promise.resolve();
        },
        keyboard: { press: (key: string) => Promise.resolve(void calls.push(key)) },
      }),
      'browser',
    );
    const opened = await browser.newTab();
    await opened.close();
    expect(await browser.evaluate(() => 41 + 1)).toBe(42);
    await browser.route('**', (value) => value + 1);
    await browser.keyboard.press('Tab');
    expect(calls).toEqual([21, 'Tab']);
    expect(sources(recorder.outcomes)).toEqual([
      'const newTab1 = await browser.newTab();',
      'await newTab1.close();',
      // A value came back, but a function of the code ran for it, which may have changed the app.
      'await browser.evaluate(() => 41 + 1);',
      "await browser.route('**', (value) => value + 1);",
      "await browser.keyboard.press('Tab');",
    ]);
  });

  it('gives a failure to the code that waits on it, and keeps one nothing waited on', async () => {
    const caught = new Recorder();
    const one = caught.wrap(fakeScreen(), 'screen');
    await expect(one.getByRole('button').missing()).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    expect(await caught.end()).toEqual({ unawaited: 0, lost: undefined });
    expect(sources(caught.outcomes)).toEqual(["failed: await screen.getByRole('button').missing();"]);

    const early = new Recorder();
    void early.wrap(fakeScreen(), 'screen').getByRole('button').missing();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await early.end()).toMatchObject({ unawaited: 0, lost: { code: 'LOCATOR_NOT_FOUND' } });

    const late = new Recorder();
    void late.wrap(fakeScreen(), 'screen').getByRole('button').missing();
    expect(await late.end()).toMatchObject({ unawaited: 1, lost: { code: 'LOCATOR_NOT_FOUND' } });
  });

  it('parks code that calls after the end at its next await, with nothing to catch and spin on', async () => {
    const recorder = new Recorder();
    const screen = recorder.wrap(fakeScreen(), 'screen');
    const button = screen.getByRole('button');
    await recorder.end();
    let tries = 0;
    let settled = false;
    // A loop that swallows each failure and tries again: an error here would spin without ever yielding.
    void (async () => {
      for (;;) {
        tries++;
        try {
          await screen.getByRole('row').nth(1).tap();
          await button.tap();
        } catch {
          continue;
        }
        settled = true;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect({ tries, settled }).toEqual({ tries: 1, settled: false });
    expect(recorder.outcomes).toEqual([]);
  });

  it('keeps a list a line resolved with a real array, and records what the code does with each item', async () => {
    const recorder = new Recorder();
    const row = (index: number) => ({ textContent: () => Promise.resolve(`row ${String(index)}`) });
    const screen = recorder.wrap({ rows: { all: () => Promise.resolve([row(0), row(1)]) } }, 'screen');
    const rows = await screen.rows.all();
    expect(Array.isArray(rows)).toBe(true);
    expect(await Promise.all(rows.map((item) => item.textContent()))).toEqual(['row 0', 'row 1']);
    expect(sources(recorder.outcomes)).toEqual(['const all1 = await screen.rows.all();', 'read: await all1[0].textContent();', 'read: await all1[1].textContent();']);
    // A promise the code got as a member is the code's own, not something to record calls on.
    const held = recorder.wrap({ ready: Promise.resolve('yes') }, 'held');
    expect(await held.ready).toBe('yes');
    expect(recorder.outcomes).toHaveLength(3);
  });
});
