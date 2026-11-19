/**
 * The click watch in a document its preload never ran in, on both BiDi
 * browsers: the first watch armed there adds the listeners, so a tap lands
 * and an overlay that takes the press is still caught.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BidiConnection } from '../../src/driver/connection.ts';
import { HIT_INTERCEPTOR_INIT_SCRIPT } from '../../src/in-page/hit-interceptor.ts';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('click watch without its preload', () => {
  let page: WebSession | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await page?.close();
    page = undefined;
  });

  it('adds its listeners with the first watch armed, lands the tap, and catches an overlay that takes the next one', async () => {
    let dropped = 0;
    const send = BidiConnection.prototype.send;
    vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
      const declaration = (params as { functionDeclaration?: unknown }).functionDeclaration;
      if (method !== 'script.addPreloadScript' || typeof declaration !== 'string' || !declaration.includes(HIT_INTERCEPTOR_INIT_SCRIPT)) return send.call(this, method, params);
      dropped += 1;
      return send.call(this, method, { ...params, functionDeclaration: '() => {}' } as never);
    });
    page = await startWebSession({ timeoutMs: 10_000 });
    expect(dropped).toBe(1);
    await page.setContent(`<button id=b style="position:absolute;left:300px;top:300px;width:100px;height:40px">b</button>
      <div id=cover style="position:absolute;left:300px;top:300px;width:100px;height:40px;display:none"></div>
      <script>
        window.log = [];
        for (const type of ['mousedown', 'mouseup', 'click']) b.addEventListener(type, () => log.push(type));
      </script>`);
    const log = (): Promise<unknown> => page!.browser.evaluate('window.log');
    const [button] = await page.locate(bySelector('#b'));
    await page.engine.perform!(button!.ref, { kind: 'tap' }, page.op());
    expect(await log()).toEqual(['mousedown', 'mouseup', 'click']);

    await page.browser.evaluate('b.addEventListener("mousemove", () => { cover.style.display = "block"; }, { once: true })');
    await page.browser.mouse.move(600, 600);
    const [covered] = await page.locate(bySelector('#b'));
    await expect(page.engine.perform!(covered!.ref, { kind: 'tap' }, page.op(2_000))).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('<div#cover> intercepts pointer events') });
    expect(await log()).toEqual(['mousedown', 'mouseup', 'click']);
  });
});
