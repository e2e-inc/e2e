/**
 * Which page holds focus, and what typed text does without it, on both BiDi
 * browsers: the tab the attempt shows holds focus and takes the whole of a
 * typed string after the app opened a tab in front of it; on Chromium every
 * tab of the attempt behaves as focused at once, through a navigation to
 * another site too, where on Firefox only the tab at the front does; and a
 * string whose character no key types finds nothing to take it fails, never
 * entered in part, unless nothing that takes keystrokes holds focus, where
 * the whole string goes nowhere as key presses do.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bySelector, onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

/** A field, the keys the page saw, and an answer to any tab that asks whether this one holds focus. */
const FIELD = `<!doctype html><title>Field</title><input id=i><div id=w tabindex=0>widget</div><div id=e contenteditable>rich</div><button id=b>Save</button><script>
  window.keys = [];
  addEventListener('keydown', (event) => keys.push(event.key), true);
  new BroadcastChannel('focus').onmessage = (event) => {
    if (event.data === 'ask') new BroadcastChannel('focus').postMessage(document.hasFocus());
  };
</script>`;

describe('focus', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000, startAttempt: false });
    page.serve('/popup', '<!doctype html><title>Popup</title><p>popup</p>');
  });
  beforeEach(async () => {
    await page.startAttempt();
  });
  afterAll(async () => {
    await page.close();
  });

  /** What the field holds, the keys the page saw, and whether its document holds focus. */
  const state = (): Promise<unknown> => page.browser.evaluate('({ value: document.getElementById("i").value, keys: window.keys.splice(0), focused: document.hasFocus() })');

  /** Has the page open `/popup` in a tab of its own, and waits until that tab joined the attempt's. */
  async function openPopup(): Promise<void> {
    await page.browser.evaluate('void (window.popup = window.open("/popup"))');
    await expect.poll(() => page.browser.tabs().length, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => page.browser.evaluate('window.popup.document.title'), { timeout: 10_000 }).toBe('Popup');
  }

  it('enters the whole of a string typed in the shown tab after the app opened a tab, which takes the front on Firefox', async () => {
    await page.setContent(FIELD);
    await page.act(bySelector('#i'), { kind: 'tap' });
    await openPopup();
    await page.browser.keyboard.type('xü');
    expect(await state()).toEqual({ value: 'xü', keys: ['x'], focused: true });
    await page.engine.keyboard!.type('née', { replace: true }, page.op());
    expect(await state()).toMatchObject({ value: 'née', focused: true });
  });

  it('has a tab the app opened behave as focused beside the shown one on Chromium; on Firefox only the tab at the front holds focus', async () => {
    await page.setContent(FIELD);
    await page.act(bySelector('#i'), { kind: 'tap' });
    await openPopup();
    await page.browser.keyboard.type('é');
    expect(await page.browser.evaluate('[document.hasFocus(), window.popup.document.hasFocus()]')).toEqual([true, !onFirefox]);
  });

  it('has a tab the attempt no longer shows behave as focused on Chromium; on Firefox only the tab at the front holds focus', async () => {
    await page.setContent(FIELD);
    await page.browser.newTab();
    await page.browser.goto('/popup');
    const first = await page.browser.evaluate(`new Promise((resolve) => {
      const channel = new BroadcastChannel('focus');
      channel.addEventListener('message', (event) => {
        if (typeof event.data === 'boolean') resolve(event.data);
      });
      channel.postMessage('ask');
    })`);
    expect([await page.browser.evaluate('document.hasFocus()'), first]).toEqual([true, !onFirefox]);
  });

  it('keeps a tab the app opened focused through its navigation to another site', async () => {
    let reported: string | undefined;
    page.serve('/focus-report', (request, response) => {
      reported = new URL(request.url ?? '', page.origin).search;
      response.writeHead(204, { 'access-control-allow-origin': '*' });
      response.end();
    });
    const landed = page.serve('/landed', `<!doctype html><title>Landed</title><script>
      addEventListener('load', () => fetch(${JSON.stringify(`${page.origin}/focus-report`)} + '?focused=' + document.hasFocus()));
    </script>`).replace('127.0.0.1', 'localhost');
    await page.setContent(FIELD);
    await openPopup();
    await page.browser.evaluate(`void (window.popup.location.href = ${JSON.stringify(landed)})`);
    await expect.poll(() => reported, { timeout: 10_000 }).toBe('?focused=true');
  });

  it('fails a string typed into a field whose document does not hold focus once its keys went out, entering no character after them', async () => {
    // Stands in for a window that lost the browser's focus under the engine: the field has the document's focus, the document reports none.
    await page.setContent(`${FIELD}<script>Document.prototype.hasFocus = () => false;</script>`);
    await page.act(bySelector('#i'), { kind: 'focus' });
    await expect(page.engine.keyboard!.type('café!', { replace: false }, page.op())).rejects.toMatchObject({
      code: 'ACTION_MAY_HAVE_COMMITTED',
      message: expect.stringMatching(/^the text was typed only in part: character 4 of the 5 typed is one no key types/),
    });
    expect(await state()).toMatchObject({ value: 'caf', keys: ['c', 'a', 'f'] });
    await expect(page.browser.keyboard.type('café!')).rejects.toThrow('the text was typed only in part: character 4 of the 5 typed');
    expect(await state()).toMatchObject({ value: 'cafcaf', keys: ['c', 'a', 'f'] });
  });

  it('fails a string whose first character no key types and nothing takes as not actionable: nothing went out', async () => {
    await page.setContent(FIELD);
    await page.act(bySelector('#w'), { kind: 'focus' });
    await expect(page.engine.keyboard!.type('ñandú', { replace: false }, page.op())).rejects.toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: expect.stringMatching(/^the text was not typed: character 1 of the 5 typed is one no key types/),
    });
    expect(await state()).toMatchObject({ value: '', keys: [] });
  });

  it('fails a string typed at a focused element that is no field once a character no key types follows its keys', async () => {
    await page.setContent(FIELD);
    await page.act(bySelector('#w'), { kind: 'focus' });
    await expect(page.engine.keyboard!.type('añb', { replace: false }, page.op())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(await state()).toMatchObject({ keys: ['a'] });
  });

  it('types a string with nothing focused as key presses with nothing focused: its keys reach the page, a character no key types goes nowhere', async () => {
    await page.setContent(FIELD);
    await page.browser.keyboard.type('añb');
    expect(await state()).toEqual({ value: '', keys: ['a', 'b'], focused: true });
  });

  it('leaves a character no key types out of an editing host that does not hold focus, as a key pressed at the focused button is', async () => {
    await page.setContent(FIELD);
    await page.browser.evaluate('void (getSelection().selectAllChildren(document.getElementById("e")), document.getElementById("b").focus())');
    await page.browser.keyboard.type('añb');
    expect(await page.browser.evaluate('[document.getElementById("e").textContent, document.activeElement.id, window.keys.splice(0)]')).toEqual(['rich', 'b', ['a', 'b']]);
  });
});
