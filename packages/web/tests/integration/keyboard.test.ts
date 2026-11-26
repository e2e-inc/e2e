/** Held keyboard input through the actual browser fixture and native DOM events. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineFixtureContext, KeyModifier, OperationContext, SemanticNode } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
describe('held keyboard input', () => {
  const surface = new PlaywrightSurface({});
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-held-keys-'));
  const signal = new AbortController().signal;
  let browser: Browser;
  beforeAll(async () => {
    await surface.init({ runId: 'held', targetName: 'web', projectRoot, app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });
  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'held', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    const page = await surface.ensurePage();
    await page.setContent('<h1 id="events"></h1>');
    browser = createBrowserFixture(surface, {
      app: { resolveUrl: (url: string) => url },
      operation: (timeoutMs = 5000) => ({ signal, timeoutMs, runId: 'held', attemptId: 'held', origin: 'test' }),
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
    await browser.evaluate(() => {
      for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
        if (!(event instanceof KeyboardEvent)) return;
        const output = document.querySelector('#events');
        if (output !== null) output.textContent += `${event.type}|${event.key}|${event.shiftKey}|${event.repeat};`;
      });
      return null;
    });
  });
  afterEach(async () => { await surface.endAttempt({ signal, timeoutMs: 5000 }); });
  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5000 });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  it('keeps a modifier held across another key and releases it for later input', async () => {
    await browser.keyboard.down('Shift');
    await browser.keyboard.press('KeyB');
    await browser.keyboard.up('Shift');
    await browser.keyboard.press('KeyB');
    const events = await browser.evaluate(() => document.querySelector('#events')?.textContent ?? '');
    expect(events).toContain('keydown|B|true|false;');
    expect(events).toContain('keyup|Shift|false|false;');
    expect(events).toContain('keydown|b|false|false;');
  });
  it('marks a second down as repeat and a later release ends the held sequence', async () => {
    await browser.keyboard.down('a');
    await browser.keyboard.down('a');
    await browser.keyboard.up('a');
    await browser.keyboard.down('a');
    await browser.keyboard.up('a');
    const events = await browser.evaluate(() => document.querySelector('#events')?.textContent ?? '');
    expect(events).toBe('keydown|a|false|false;keydown|a|false|true;keyup|a|false|false;keydown|a|false|false;keyup|a|false|false;');
  });

  describe('with a modified tap at a point', () => {
    const metaKey = process.platform === 'darwin' ? 'Meta' : 'Control';

    const operation = (): OperationContext => ({ signal, timeoutMs: 5000, runId: 'held', attemptId: 'held', origin: 'test' });

    beforeEach(async () => {
      await browser.evaluate(() => {
        document.body.insertAdjacentHTML(
          'beforeend',
          '<input aria-label="Field" value="old"><div id="pad" style="position: fixed; left: 0; top: 100px; width: 200px; height: 100px"></div><p id="log"></p>',
        );
        const log = document.querySelector('#log')!;
        for (const type of ['keydown', 'keyup']) {
          document.addEventListener(type, (event) => {
            if (event instanceof KeyboardEvent && !event.repeat) log.textContent += `${type} ${event.key};`;
          });
        }

        document.querySelector('#pad')!.addEventListener('click', (event) => {
          if (!(event instanceof MouseEvent)) return;
          const held = [event.altKey && 'Alt', event.ctrlKey && 'Control', event.metaKey && 'Meta', event.shiftKey && 'Shift'].filter(Boolean);
          log.textContent += `click ${held.join('+') || 'none'};`;
        });
        return null;
      });
      await surface.observe(operation());
    });

    /** Taps the pad at a point holding `modifiers`. */
    const tapPad = (modifiers?: readonly KeyModifier[]): Promise<void> =>
      surface.performAt({ x: 50, y: 150 }, { kind: 'tap', ...(modifiers === undefined ? {} : { modifiers }) }, operation());

    /** The key and click events since the last call, then clears them. */
    const log = (): Promise<string[]> =>
      browser.evaluate(() => {
        const node = document.querySelector('#log')!;
        const events = (node.textContent ?? '').split(';').filter((event) => event !== '');
        node.textContent = '';
        return events;
      });

    it('restores a key held with down(ControlOrMeta) after a tap that names another', async () => {
      await browser.keyboard.down('ControlOrMeta');
      await tapPad(['Alt']);
      await browser.keyboard.up('ControlOrMeta');
      expect(await log()).toEqual([`keydown ${metaKey}`, 'keydown Alt', `keyup ${metaKey}`, 'click Alt', 'keyup Alt', `keydown ${metaKey}`, `keyup ${metaKey}`]);
    });

    it.each([
      ['a node press', async () => {
        const field = (await surface.observe(operation())).root;
        const find = (node: SemanticNode): SemanticNode | undefined => node.name === 'Field' ? node : node.children?.map(find).find((match) => match !== undefined);
        const node = find(field);
        if (node === undefined) throw new Error('no Field on the screen');
        await surface.perform(node.ref, { kind: 'press', key: 'Shift+ArrowLeft' }, operation());
      }],
      ['a keyboard press', async () => {
        await surface.pressKey('Shift+ArrowLeft', operation());
      }],
      ['a replacing type', async () => {
        await browser.evaluate(() => {
          document.querySelector('input')!.focus();
          return null;
        });
        await surface.typeText('new', { replace: true }, operation());
      }],
    ])('forgets a modifier the engine releases in %s, so a later tap does not press it again', async (_name, release) => {
      const modifier = _name === 'a replacing type' ? 'ControlOrMeta' : 'Shift';
      await browser.keyboard.down(modifier);
      await release();
      await log();
      await tapPad(['Alt']);
      expect(await log()).toEqual(['keydown Alt', 'click Alt', 'keyup Alt']);
    });
  });
});
