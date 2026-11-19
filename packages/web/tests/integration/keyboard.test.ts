/** Held keyboard input and typed text through the actual browser fixture and native DOM events. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BidiConnection } from '../../src/driver/connection.ts';
import type { Browser } from '../../src/fixture/types.ts';
import { onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';
describe('held keyboard input', () => {
  let session: WebSession;
  let browser: Browser;
  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 5_000, startAttempt: false });
  });
  beforeEach(async () => {
    await session.startAttempt();
    await session.setContent('<h1 id="events"></h1>');
    browser = session.browser;
    await browser.evaluate(() => {
      for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
        if (!(event instanceof KeyboardEvent)) return;
        const output = document.querySelector('#events');
        if (output !== null) output.textContent += `${event.type}|${event.key}|${event.shiftKey}|${event.repeat};`;
      });
      return null;
    });
  });
  afterEach(async () => { await session.endAttempt(); });
  afterAll(async () => { await session.close(); });
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
  it('presses a media key over CDP on Chromium, refuses it on Firefox, and presses NumpadDecimal with NumLock off', async () => {
    await browser.keyboard.press('Shift');
    // WebDriver defines no key value for MediaPlayPause; only Chromium presses it, over CDP.
    const media = browser.keyboard.press('MediaPlayPause');
    if (onFirefox) await expect(media).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('WebDriver defines no key value for "MediaPlayPause"') });
    else await media;
    await browser.keyboard.press('NumpadDecimal');
    const events = await browser.evaluate(() => document.querySelector('#events')?.textContent ?? '');
    const mediaEvents = onFirefox ? '' : 'keydown|MediaPlayPause|false|false;keyup|MediaPlayPause|false|false;';
    expect(events).toBe(`keydown|Shift|true|false;keyup|Shift|false|false;${mediaEvents}keydown|Delete|false|false;keyup|Delete|false|false;`);
  });
  it.runIf(process.platform === 'darwin')('runs the macOS editing command of a shortcut, with a modifier held by keyboard.down', async () => {
    await session.setContent('<div contenteditable>one two</div>');
    await browser.evaluate(() => { document.querySelector<HTMLElement>('div')?.focus(); return null; });
    await browser.keyboard.press('Meta+ArrowRight');
    await browser.keyboard.down('Shift');
    await browser.keyboard.press('Alt+ArrowLeft');
    await browser.keyboard.up('Shift');
    expect(await browser.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('two');
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
});

describe('typed text no key of the keyboard types', () => {
  let session: WebSession;
  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 5_000 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => { await session.close(); });

  it('is inserted where focus is, a run of it in one page call and one edit per character', async () => {
    await session.setContent('<iframe srcdoc="<input id=field>"></iframe>');
    await session.waitForFrames();
    await session.browser.evaluate(() => {
      const field = document.querySelector('iframe')!.contentDocument!.querySelector<HTMLInputElement>('#field')!;
      const edits: (string | null)[] = [];
      Reflect.set(window, 'edits', edits);
      field.addEventListener('input', (event) => edits.push((event as InputEvent).data));
      field.focus();
      return null;
    });
    const sent: string[] = [];
    const send = BidiConnection.prototype.send;
    vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
      const declaration = (params as { functionDeclaration?: unknown }).functionDeclaration;
      if (method === 'browsingContext.getTree' || (typeof declaration === 'string' && declaration.includes('insertText'))) sent.push(method);
      return send.call(this, method, params);
    });
    await session.browser.keyboard.type('aこんにちはb');
    // One read of the tab's documents, then one insert offered to the top document and one to the frame holding focus.
    expect(sent).toEqual(['browsingContext.getTree', 'script.callFunction', 'script.callFunction']);
    expect(await session.browser.evaluate(() => ({
      value: document.querySelector('iframe')!.contentDocument!.querySelector<HTMLInputElement>('#field')!.value,
      edits: Reflect.get(window, 'edits') as string[],
    }))).toEqual({ value: 'aこんにちはb', edits: ['a', 'こ', 'ん', 'に', 'ち', 'は', 'b'] });
  });
});

describe('typed text that keys would not type as written', () => {
  let session: WebSession;
  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 5_000, startAttempt: false });
  });
  beforeEach(async () => {
    await session.startAttempt();
    await session.setContent(`<textarea id="field"></textarea><input id="next"><p id="keys"></p>
      <script>document.addEventListener('keydown', (event) => { document.getElementById('keys').textContent += event.key + (event.shiftKey ? '+shift;' : ';'); });</script>`);
  });
  afterEach(async () => { await session.endAttempt(); });
  afterAll(async () => { await session.close(); });

  /** The field's value, which element holds focus, and the keys the page heard go down. */
  const page = (): Promise<{ value: string; focus: string | null; keys: string }> => session.browser.evaluate(() => ({
    value: document.querySelector<HTMLTextAreaElement>('#field')!.value,
    focus: document.activeElement?.id ?? null,
    keys: document.getElementById('keys')!.textContent ?? '',
  }));

  it('types a tab into the field, where the Tab key would move focus out of it', async () => {
    await session.browser.evaluate(() => (document.getElementById('field')!.focus(), null));
    await session.browser.keyboard.type('a\tb');
    expect(await page()).toEqual({ value: 'a\tb', focus: 'field', keys: 'a;b;' });
  });

  it('types the text as written with Shift held, and Shift stays held for the key after it', async () => {
    await session.browser.evaluate(() => (document.getElementById('field')!.focus(), null));
    await session.browser.keyboard.down('Shift');
    await session.browser.keyboard.type('ab1');
    await session.browser.keyboard.press('KeyC');
    await session.browser.keyboard.up('Shift');
    // Chromium types each with its key's events; Firefox has no key event that enters text other than its key's, so it inserts them.
    const typed = onFirefox ? '' : 'a+shift;b+shift;1+shift;';
    expect(await page()).toEqual({ value: 'ab1C', focus: 'field', keys: `Shift+shift;${typed}C+shift;` });
  });

  it('presses the keys of characters Shift does not change, with Shift held', async () => {
    await session.browser.evaluate(() => (document.getElementById('field')!.focus(), null));
    await session.browser.keyboard.down('Shift');
    await session.browser.keyboard.type('~A !');
    await session.browser.keyboard.up('Shift');
    expect(await page()).toEqual({ value: '~A !', focus: 'field', keys: 'Shift+shift;~+shift;A+shift; +shift;!+shift;' });
  });

  it('presses the keys of text typed with Shift held where no field takes it', async () => {
    await session.browser.keyboard.down('Shift');
    await session.browser.keyboard.type('g');
    await session.browser.keyboard.up('Shift');
    expect((await page()).keys).toMatch(/^Shift\+shift;[gG]\+shift;$/);
  });
});
