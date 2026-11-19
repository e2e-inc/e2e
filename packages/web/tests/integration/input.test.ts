/**
 * Input on both BiDi browsers, as a page sees it: a key held across a
 * Shift change gets its keyup, Shift shifts a key named by its character,
 * a swipe leaves the mouse on what it scrolled, a drag carries pressure,
 * lasts as long as asked, and reaches a target in a rotated frame, a
 * pointer target outside the viewport is refused as never sent, a tap
 * lands in what shows of a node in a shadow root, a tap cancelled while it
 * aims leaves no click watch behind, a click the app dispatched itself is
 * left to the app while the driver's own arrives trusted, a click no event
 * of the element's document saw may have committed, a fill fires its
 * events with the `Event` the page started with, a ref reused after input,
 * the hover of a swallowed click included, checks its locator again, a
 * fill still running in the page at its deadline may have committed, a
 * press, a fill, or a select of an element the page took out of the
 * document is stale and changes nothing, a press or a focus on a node of a
 * document a navigation replaced, or of a frame that is gone, is stale
 * too, so a locator's press lands in the document that replaced it, a node
 * of a document of another origin of the same site is stale as well, a
 * node the browser refused after the read of it is stale on Chromium, which
 * refuses it before anything runs, and possibly committed on Firefox, a
 * select or a fill that polls is stale once a navigation replaced its
 * document between two tries, so a locator's lands in the document that
 * replaced it, and a press whose focus handler took its document away may
 * have committed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LocatorExpression } from '@e2e-dev/core/engine';
import { callOf } from '../helpers/page-call.ts';
import { bySelector, onFirefox, startPageServer, startWebSession, type WebSession } from '../helpers/web-session.ts';
import { BidiConnection } from '../../src/driver/connection.ts';
import { ROOT_NODE_ID } from '../../src/driver/observe.ts';
import { callFunction } from '../../src/driver/script.ts';
import { elementAttached, fill, focus, selectOption } from '../../src/in-page/edits.ts';

const send = BidiConnection.prototype.send;

/**
 * Has the page run `change` just before the driver's next call of the page
 * function `fn`, as an app that changes between a check of the driver's and
 * the mutation after it.
 */
function beforeNext(fn: { toString(): string }, change: string): void {
  let changed = false;
  vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
    const context = changed ? undefined : callOf(fn, params);
    if (context === undefined) return send.call(this, method, params);
    changed = true;
    return callFunction(this, context, `() => { ${change} }`).then(() => send.call(this, method, params));
  });
}

/**
 * Has the tab finish a navigation to `url` just before the driver's next
 * call of the page function `fn`, once `passed` calls of it went out, as a
 * page that navigates between a locate and the action after it, or between
 * two tries of an action that polls.
 */
function navigatedBeforeNext(fn: { toString(): string }, url: string, passed = 0): void {
  let left = passed;
  let navigated = false;
  vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
    const context = navigated ? undefined : callOf(fn, params);
    if (context === undefined) return send.call(this, method, params);
    if (left > 0) {
      left -= 1;
      return send.call(this, method, params);
    }
    navigated = true;
    return send.call(this, 'browsingContext.navigate', { context, url, wait: 'complete' }).then(() => send.call(this, method, params));
  });
}

/** Escapes HTML for a single-quoted attribute value, so a document can carry a `srcdoc`. */
function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
}

describe('input', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await page.close();
  });

  /** The events the page logged into `window.log`. */
  const log = (): Promise<unknown> => page.browser.evaluate('window.log');

  it('releases a key held across a Shift change with the key it pressed', async () => {
    await page.setContent(`<input id=i><script>
      window.log = [];
      for (const type of ['keydown', 'keyup']) addEventListener(type, (event) => log.push(type + ':' + event.key), true);
    </script>`);
    await page.browser.evaluate('document.getElementById("i").focus()');
    const { keyboard } = page.browser;
    await keyboard.down('Shift');
    await keyboard.down('a');
    await keyboard.up('Shift');
    await keyboard.up('a');
    await keyboard.press('b');
    expect(await log()).toEqual(['keydown:Shift', 'keydown:A', 'keyup:Shift', 'keyup:A', 'keydown:b', 'keyup:b']);
  });

  it('shifts a key named by its character, through the fixture and the contract alike', async () => {
    await page.setContent('<input id=i><input id=j>');
    await page.browser.evaluate('document.getElementById("i").focus()');
    for (const key of ['Shift+a', 'Shift+1', 'Shift+Digit2']) await page.browser.keyboard.press(key);
    await page.browser.evaluate('document.getElementById("j").focus()');
    for (const key of ['Shift+a', 'Shift+1']) await page.engine.keyboard!.press(key, page.op());
    expect(await page.browser.evaluate('[document.getElementById("i").value, document.getElementById("j").value]')).toEqual(['A!@', 'A!']);
  });

  it('leaves the mouse on what a swipe scrolled, so a viewport swipe scrolls it again', async () => {
    await page.setContent(`<div style="height:3000px;padding-top:150px">
      <div id=s onmouseenter="window.entered = true" style="margin-left:200px;width:300px;height:200px;overflow:auto"><div style="height:5000px">inner</div></div>
    </div>`);
    await page.act(bySelector('#s'), { kind: 'swipe', direction: 'down' });
    const first = await page.browser.evaluate('({ inner: document.getElementById("s").scrollTop, entered: window.entered === true })') as { inner: number; entered: boolean };
    expect(first.entered).toBe(true);
    expect(first.inner).toBeGreaterThan(0);
    await page.engine.perform!({ id: ROOT_NODE_ID } as never, { kind: 'swipe', direction: 'down' }, page.op());
    expect(await page.browser.evaluate('[document.getElementById("s").scrollTop > ' + String(first.inner) + ', scrollY]')).toEqual([true, 0]);
  });

  it('presses every move of a pointer drag with a held button\'s pressure', async () => {
    await page.setContent(`<div style="width:600px;height:400px"></div><script>
      window.log = [];
      addEventListener('pointermove', (event) => { if (event.buttons) log.push(event.pressure); }, true);
    </script>`);
    await page.engine.performAt!({ x: 50, y: 50 }, { kind: 'dragTo', target: { x: 300, y: 200 } }, page.op());
    expect(await log()).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it('holds a swipe between points for its whole duration', async () => {
    await page.setContent(`<div style="width:600px;height:400px"></div><script>
      window.log = [];
      for (const type of ['pointerdown', 'pointerup']) addEventListener(type, (event) => log.push(event.timeStamp), true);
    </script>`);
    await page.engine.performAt!({ x: 50, y: 50 }, { kind: 'swipeTo', target: { x: 300, y: 200 }, durationMs: 1_500 }, page.op());
    const [down, up] = await log() as number[];
    expect(up! - down!).toBeGreaterThanOrEqual(1_500);
  });

  it('drags onto a target in a rotated frame, resolving the target once the source is pressed', async () => {
    const inner = '<div id=dst style="width:120px;height:120px;background:blue" onmouseup="parent.ups = (parent.ups || 0) + 1">drop</div>';
    await page.setContent(`<div id=src style="width:60px;height:60px;background:red">drag</div>
      <iframe id=f style="transform:rotate(15deg);margin:40px;width:300px;height:200px" srcdoc='${attribute(inner)}'></iframe>`);
    await page.waitForFrames();
    const target: LocatorExpression = { kind: 'frame', selector: '#f', source: bySelector('#dst') };
    const [dst] = await page.locate(target);
    await page.act(bySelector('#src'), { kind: 'dragTo', target: dst!.ref });
    expect(await page.browser.evaluate('window.ups ?? 0')).toBe(1);
  });

  it('drops an HTML5 drag with the data the page set on Chromium, and refuses it on Firefox, whose remote agent drops none', async () => {
    await page.setContent(`<div id=card draggable=true style="width:80px;height:30px">card</div><div id=done style="margin-top:100px;width:200px;height:100px">done</div>
      <script>
        window.log = [];
        card.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', 'card'));
        done.addEventListener('dragover', (event) => event.preventDefault());
        done.addEventListener('drop', (event) => { event.preventDefault(); log.push(event.dataTransfer.getData('text/plain')); });
      </script>`);
    const drop = page.browser.locator('#card').dragTo(page.browser.locator('#done'));
    if (onFirefox) {
      await expect(drop).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('show_bug.cgi?id=1515879') });
      // The button is up: the page takes input again.
      await page.browser.locator('#done').tap();
    } else {
      await drop;
    }
    expect(await log()).toEqual(onFirefox ? [] : ['card']);
  });

  it.each([
    ['a source the first step of the drag leaves', 80, 30],
    ['a source the first step of the drag stays on', 600, 300],
  ])('ends an HTML5 drag from %s with its drop and no pointer or mouse release, as a person\'s drag does, and takes a tap after it', async (_name, width, height) => {
    await page.setContent(`<div id=card draggable=true style="width:${String(width)}px;height:${String(height)}px">card</div><div id=done style="margin-top:20px;width:200px;height:100px">done</div>
      <script>
        window.log = [];
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'pointercancel', 'click', 'dragstart', 'drop', 'dragend']) {
          addEventListener(type, (event) => log.push(type + ':' + event.target.id), true);
        }
        card.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', 'card'));
        done.addEventListener('dragover', (event) => event.preventDefault());
        done.addEventListener('drop', (event) => event.preventDefault());
      </script>`);
    const drop = page.browser.locator('#card').dragTo(page.browser.locator('#done'));
    if (onFirefox) await expect(drop).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    else await drop;
    // Firefox drops no drag the page starts, so the drag it refuses ends without a drop and its release reaches the page, with a click on what holds both ends.
    expect(await page.browser.evaluate('window.log.splice(0).filter((line) => !line.startsWith("pointercancel")).map((line) => line.replace(/:(?!card|done).*$/, ":"))')).toEqual(onFirefox
      ? ['pointerdown:card', 'mousedown:card', 'dragstart:card', 'dragend:card', 'pointerup:done', 'mouseup:done', 'click:']
      : ['pointerdown:card', 'mousedown:card', 'dragstart:card', 'drop:done', 'dragend:card']);
    await page.browser.locator('#done').tap();
    expect(await page.browser.evaluate('window.log')).toEqual(['pointerdown:done', 'mousedown:done', 'pointerup:done', 'mouseup:done', 'click:done']);
  });

  it('refuses a pointer target outside the viewport before sending anything, and takes its far edge', async () => {
    await page.setContent('<button style="width:200px;height:100px" onmouseleave="window.left = true">hover me</button>');
    await page.browser.mouse.move(50, 50);
    await expect(page.browser.mouse.move(-1, -1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('outside the 1280x720 viewport') });
    await expect(page.engine.performAt!({ x: 1283, y: 10 }, { kind: 'tap' }, page.op())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await page.browser.evaluate('window.left ?? false')).toBe(false);
    await page.engine.performAt!({ x: 1280, y: 720 }, { kind: 'hover' }, page.op());
    expect(await page.browser.evaluate('window.left ?? false')).toBe(true);
  });

  it('taps the centre of what shows of a node in a shadow root, cut by a clip around the root\'s host', async () => {
    await page.setContent(`<style>body { margin: 0 }</style>
      <div style="width:100px;height:40px;overflow:hidden"><div id="host"></div></div>
      <script>
        addEventListener('click', (event) => { document.title = event.clientX + ',' + event.clientY; }, true);
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<div id="wide" style="width:160px;height:40px"></div>';
      </script>`);
    await page.act(bySelector('#wide'), { kind: 'tap' });
    expect(await page.browser.evaluate(() => document.title)).toBe('50,20');
  });

  it('taps the centre of what shows of a slotted node, cut by a clip around its slot', async () => {
    await page.setContent(`<style>body { margin: 0 }</style>
      <div id="host"><div id="wide" style="width:160px;height:40px"></div></div>
      <script>
        addEventListener('click', (event) => { document.title = event.clientX + ',' + event.clientY; }, true);
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<div style="width:100px;height:40px;overflow:hidden"><slot></slot></div>';
      </script>`);
    await page.act(bySelector('#wide'), { kind: 'tap' });
    expect(await page.browser.evaluate(() => document.title)).toBe('50,20');
  });

  it('arms no click watch for a tap cancelled while it aims, so the pointer input after it reaches the page', async () => {
    const controller = new AbortController();
    const cancel = page.serve('/cancel-tap', (_request, response) => {
      controller.abort(new Error('cancelled'));
      response.end();
    });
    // The tap scrolls the button into view, and the page cancels it there, in the middle of its aim. The aim ends with a hit test.
    await page.setContent(`<div style="height:2000px"></div><button id=far>far</button><script>
      window.log = [];
      addEventListener('scroll', () => {
        const request = new XMLHttpRequest();
        request.open('GET', ${JSON.stringify(cancel)}, false);
        request.send();
        window.cancelled = true;
      }, { once: true });
      const hitTest = document.elementFromPoint.bind(document);
      document.elementFromPoint = (x, y) => {
        window.aimed = window.cancelled === true;
        return hitTest(x, y);
      };
      for (const type of ['mousedown', 'mouseup', 'click']) addEventListener(type, () => log.push(type), true);
    </script>`);
    const [far] = await page.locate(bySelector('#far'));
    await expect(page.engine.perform!(far!.ref, { kind: 'tap' }, { ...page.op(), signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => page.browser.evaluate('window.aimed === true'), { timeout: 10_000 }).toBe(true);
    await page.engine.performAt!({ x: 5, y: 5 }, { kind: 'tap' }, page.op());
    expect(await log()).toEqual(['mousedown', 'mouseup', 'click']);
  });

  it('checks a ref reused after input still names its locator\'s only match', async () => {
    await page.setContent('<button id=a onclick="document.body.append(Object.assign(document.createElement(\'button\'), { className: \'twin\', textContent: \'twin\' }))" class=twin>twin</button>');
    const [twin] = await page.locate(bySelector('.twin'));
    await page.engine.perform!(twin!.ref, { kind: 'tap' }, page.op());
    await expect(page.engine.perform!(twin!.ref, { kind: 'tap' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', message: expect.stringContaining('now matches 2 elements') });
  });

  it('suppresses a click an overlay took ahead of the page\'s own capture listeners on the window', async () => {
    await page.setContent(`<button id=b style="position:absolute;left:300px;top:300px;width:100px;height:40px">b</button>
      <div id=cover style="position:absolute;left:300px;top:300px;width:100px;height:40px;display:none"></div>
      <script>
        window.log = [];
        for (const type of ['mousedown', 'mouseup', 'click']) addEventListener(type, () => log.push(type), true);
        b.addEventListener('mousemove', () => { cover.style.display = 'block'; }, { once: true });
      </script>`);
    await page.browser.mouse.move(600, 600);
    const [covered] = await page.locate(bySelector('#b'));
    await expect(page.engine.perform!(covered!.ref, { kind: 'tap' }, page.op(2_000))).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('<div#cover> intercepts pointer events') });
    expect(await log()).toEqual([]);
  });

  it('leaves a click the app dispatched itself as the pointer arrived to the app, and lands the tap on the first try', async () => {
    await page.setContent(`<button id=target style="position:absolute;left:300px;top:300px;width:100px;height:40px">target</button>
      <button id=other style="position:absolute;left:300px;top:400px;width:100px;height:40px">other</button>
      <script>
        window.log = [];
        window.moves = 0;
        other.addEventListener('click', (event) => log.push('other:' + event.isTrusted));
        target.addEventListener('click', (event) => log.push('target:' + event.isTrusted));
        target.addEventListener('pointermove', () => {
          moves += 1;
          other.click();
        });
      </script>`);
    await page.browser.mouse.move(600, 600);
    const [target] = await page.locate(bySelector('#target'));
    await page.engine.perform!(target!.ref, { kind: 'tap' }, page.op(2_000));
    const moves = await page.browser.evaluate<number>('window.moves');
    expect(moves).toBeGreaterThan(0);
    expect(await log()).toEqual([...Array.from({ length: moves }, () => 'other:false'), 'target:true']);
  });

  it('sends every event the click watch decides on as a trusted one', async () => {
    await page.setContent(`<button id=b style="position:absolute;left:300px;top:300px;width:100px;height:40px">b</button>
      <script>
        window.log = [];
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu']) {
          addEventListener(type, (event) => {
            if (type === 'contextmenu') event.preventDefault();
            log.push(type + ':' + event.isTrusted);
          }, true);
        }
      </script>`);
    const [button] = await page.locate(bySelector('#b'));
    await page.engine.perform!(button!.ref, { kind: 'doubleTap' }, page.op());
    await page.engine.perform!(button!.ref, { kind: 'secondaryTap' }, page.op());
    const seen = (await log()) as string[];
    expect(seen.filter((entry) => !entry.endsWith(':true'))).toEqual([]);
    expect([...new Set(seen)].toSorted()).toEqual(['auxclick:true', 'click:true', 'contextmenu:true', 'dblclick:true', 'mousedown:true', 'mouseup:true', 'pointerdown:true', 'pointerup:true']);
  });

  it('counts the hover of a click an overlay swallowed as input, so a ref located before it is checked again', async () => {
    // The pointer arriving on the button adds a twin of the located element and raises an overlay that takes the press.
    await page.setContent(`<button class=twin>twin</button>
      <button id=b style="position:absolute;left:300px;top:300px;width:100px;height:40px">b</button>
      <div id=cover style="position:absolute;left:300px;top:300px;width:100px;height:40px;display:none"></div>
      <script>
        b.addEventListener('mousemove', () => {
          document.body.append(Object.assign(document.createElement('button'), { className: 'twin', textContent: 'twin' }));
          cover.style.display = 'block';
        }, { once: true });
      </script>`);
    await page.browser.mouse.move(600, 600);
    const [twin] = await page.locate(bySelector('.twin'));
    const [covered] = await page.locate(bySelector('#b'));
    await expect(page.engine.perform!(covered!.ref, { kind: 'tap' }, page.op(2_000))).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('<div#cover> intercepts pointer events') });
    await expect(page.engine.perform!(twin!.ref, { kind: 'tap' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', message: expect.stringContaining('now matches 2 elements') });
  });

  it('reports a click no event of the element\'s document saw as possibly committed, naming what can take one from a top-level element and from one in a frame', async () => {
    const elsewhere = { code: 'ACTION_MAY_HAVE_COMMITTED', message: expect.stringContaining('a frame or another document\'s overlay over the element, or what the browser shows in front of the page') };
    // The pointer arriving on the button moves a frame over it, which takes the press.
    await page.setContent(`<button id=b style="position:absolute;left:300px;top:300px;width:100px;height:40px">b</button>
      <iframe id=cover style="position:absolute;left:-500px;top:280px;width:140px;height:80px;border:0" srcdoc='${attribute('<script>addEventListener("click", () => { parent.taken = true; });</script>')}'></iframe>
      <script>b.addEventListener('mousemove', () => { cover.style.left = '280px'; }, { once: true });</script>`);
    await page.waitForFrames();
    await page.browser.mouse.move(600, 600);
    const [top] = await page.locate(bySelector('#b'));
    await expect(page.engine.perform!(top!.ref, { kind: 'tap' }, page.op(2_000))).rejects.toMatchObject(elsewhere);
    expect(await page.browser.evaluate('window.taken === true')).toBe(true);
    // The pointer arriving on the button in the frame raises an overlay over the frame, in its parent.
    const inner = '<button id=b style="width:100px;height:40px" onmousemove="parent.document.getElementById(\'cover\').style.display = \'block\'">b</button>';
    await page.setContent(`<iframe id=f style="position:absolute;left:300px;top:300px;width:200px;height:100px;border:0" srcdoc='${attribute(inner)}'></iframe>
      <div id=cover onclick="window.taken = true" style="position:absolute;left:300px;top:300px;width:200px;height:100px;display:none"></div>`);
    await page.waitForFrames();
    await page.browser.mouse.move(600, 600);
    const [framed] = await page.locate({ kind: 'frame', selector: '#f', source: bySelector('#b') });
    await expect(page.engine.perform!(framed!.ref, { kind: 'tap' }, page.op(2_000))).rejects.toMatchObject(elsewhere);
    expect(await page.browser.evaluate('window.taken === true')).toBe(true);
  });

  it('fires the events of a fill with the Event constructor the page had before it replaced it', async () => {
    await page.setContent(`<input id=i type=range max=10><script>
      window.log = [];
      for (const type of ['input', 'change']) i.addEventListener(type, (event) => log.push(type + ':' + event.target.value));
      window.Event = function () { throw new Error('the page replaced Event'); };
    </script>`);
    await page.act(bySelector('#i'), { kind: 'fill', value: '7', sensitive: false });
    expect(await log()).toEqual(['input:7', 'change:7']);
  });

  it.each([
    [' 12 ', '12', ['input:12']],
    [' -1.5e3 ', '-1.5e3', ['input:-1.5e3']],
    ['\t7\n', '7', ['input:7']],
    ['   ', '', ['input:']],
    ['', '', ['input:']],
    ['1e3', '1e3', ['input:1e3']],
    ['-0', '-0', ['input:-0']],
    ['012', '012', ['input:012']],
  ])('fills a number input with %j, trimmed, in one edit', async (value, held, events) => {
    await page.setContent(`<input id=n type=number value=5><script>
      window.log = [];
      for (const type of ['input', 'change']) n.addEventListener(type, (event) => log.push(type + ':' + event.target.value));
    </script>`);
    await page.act(bySelector('#n'), { kind: 'fill', value, sensitive: false });
    expect(await page.browser.evaluate('document.getElementById("n").value')).toBe(held);
    expect(await log()).toEqual(events);
  });

  it.each([
    ['1,5', 'Cannot type text into input[type=number]'],
    [' 1 2 ', 'Cannot type text into input[type=number]'],
    ['1.', 'Malformed value'],
    ['+1', 'Malformed value'],
    ['0x10', 'Malformed value'],
  ])('refuses a number input %j, which no number input keeps, and leaves the field as it was', async (value, reason) => {
    await page.setContent(`<input id=n type=number value=5 min=0 max=3 step=2><script>
      window.log = [];
      for (const type of ['focus', 'beforeinput', 'input', 'change']) n.addEventListener(type, () => log.push(type));
    </script>`);
    const [number] = await page.locate(bySelector('#n'));
    await expect(page.engine.perform!(number!.ref, { kind: 'fill', value, sensitive: false }, page.op())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining(reason) });
    expect(await page.browser.evaluate('document.getElementById("n").value')).toBe('5');
    expect(await log()).toEqual([]);
  });

  it('fills a number input with a number its own step, min, and max do not allow, which it keeps', async () => {
    await page.setContent('<input id=n type=number value=2 min=0 max=3 step=2>');
    await page.act(bySelector('#n'), { kind: 'fill', value: '7.5', sensitive: false });
    expect(await page.browser.evaluate('document.getElementById("n").value')).toBe('7.5');
  });

  it.each([
    ['clamps a value past its limit', 'if (n.valueAsNumber > 10) n.value = 10', { kind: 'fill', value: '25', sensitive: false }, '10'],
    ['writes a number back over an emptied field, on a fill', 'n.value = String(Number(n.value))', { kind: 'fill', value: '', sensitive: false }, '0'],
    ['writes a number back over an emptied field, on a clear', 'n.value = String(Number(n.value))', { kind: 'clear' }, '0'],
  ] as const)('leaves a number input as its own input handler left it, in one edit: it %s', async (_name, handler, action, held) => {
    await page.setContent(`<input id=n type=number value=5><script>
      window.log = [];
      n.addEventListener('input', () => { ${handler}; });
      for (const type of ['input', 'change']) n.addEventListener(type, (event) => log.push(type + ':' + String(event.isTrusted)));
    </script>`);
    await page.act(bySelector('#n'), action);
    expect(await page.browser.evaluate('document.getElementById("n").value')).toBe(held);
    expect(await log()).toEqual(['input:true']);
  });

  it.each([
    ['date', ' 2024-01-02 ', '2024-01-02'],
    ['time', ' 12:30 ', '12:30'],
    ['datetime-local', ' 2024-01-02T12:30 ', '2024-01-02T12:30'],
    ['color', ' #ff0000 ', '#ff0000'],
    ['range', ' 7 ', '7'],
    // Firefox has no month or week input: each is a text field there, and keeps the value as given.
    ['month', ' 2024-01 ', onFirefox ? ' 2024-01 ' : '2024-01'],
    ['week', ' 2024-W01 ', onFirefox ? ' 2024-W01 ' : '2024-W01'],
  ])('sets a %s input to a padded value trimmed, which it then holds', async (type, value, held) => {
    await page.setContent(`<input id=i type="${type}" max=10>`);
    await page.act(bySelector('#i'), { kind: 'fill', value, sensitive: false });
    expect(await page.browser.evaluate('[document.getElementById("i").type, document.getElementById("i").value]')).toEqual([onFirefox && (type === 'month' || type === 'week') ? 'text' : type, held]);
  });

  it('counts a fill the page saw and then refused as input, so a ref reused after it is checked again', async () => {
    // The field gives focus up as it takes it, after its handler added a twin of the located element.
    await page.setContent('<input id=i onfocus="document.body.append(Object.assign(document.createElement(\'button\'), { className: \'twin\', textContent: \'twin\' })); this.blur()"><button class=twin>twin</button>');
    const [twin] = await page.locate(bySelector('.twin'));
    const [field] = await page.locate(bySelector('#i'));
    await expect(page.engine.perform!(field!.ref, { kind: 'fill', value: 'x', sensitive: false }, page.op())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('element could not be focused') });
    await expect(page.engine.perform!(twin!.ref, { kind: 'tap' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', message: expect.stringContaining('elements') });
  });

  it('reports a fill whose input handler still runs at the deadline as possibly committed: the field holds the value', async () => {
    let release = (): void => undefined;
    const hold = page.serve('/hold-fill', (_request, response) => {
      release = () => response.end();
    });
    await page.setContent(`<input id=i><script>
      i.addEventListener('input', () => {
        const request = new XMLHttpRequest();
        request.open('GET', ${JSON.stringify(hold)}, false);
        request.send();
      });
    </script>`);
    const [field] = await page.locate(bySelector('#i'));
    await expect(page.engine.perform!(field!.ref, { kind: 'fill', value: 'held', sensitive: false }, page.op(1_000))).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    release();
    expect(await page.browser.evaluate('document.getElementById("i").value')).toBe('held');
  });

  it('fails a press on an observed node the page removed as stale, and sends its key to nothing', async () => {
    await page.setContent('<input id=kept><button id=gone>gone</button>');
    const gone = (await page.nodes()).find((node) => node.name === 'gone');
    await page.browser.evaluate(() => {
      document.getElementById('gone')!.remove();
      document.getElementById('kept')!.focus();
      return null;
    });
    await expect(page.engine.perform!(gone!.ref, { kind: 'press', key: 'x' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(await page.browser.evaluate('document.getElementById("kept").value')).toBe('');
  });

  it('fails a press and a focus on an observed node whose document a navigation replaced as stale, and sends its key to nothing', async () => {
    await page.setContent('<button id=old>old</button>');
    const old = (await page.nodes()).find((node) => node.name === 'old');
    await page.setContent('<input id=kept>');
    await page.browser.evaluate(() => {
      document.getElementById('kept')!.focus();
      return null;
    });
    await expect(page.engine.perform!(old!.ref, { kind: 'press', key: 'x' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    await expect(page.engine.perform!(old!.ref, { kind: 'focus' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(await page.browser.evaluate('document.getElementById("kept").value')).toBe('');
  });

  it.each([
    ['removed', 'document.getElementById("f").remove()'],
    ['put another in the place of', 'document.getElementById("f").replaceWith(document.getElementById("f").cloneNode())'],
  ])('fails a press and a focus on an observed node of a frame the page %s as stale, and sends its key to nothing', async (_how, change) => {
    await page.setContent(`<input id=kept><iframe id=f srcdoc='${attribute('<button>framed</button>')}'></iframe>`);
    await page.waitForFrames();
    const framed = (await page.nodes()).find((node) => node.name === 'framed')!.ref;
    await page.browser.evaluate(`(() => { ${change}; document.getElementById("kept").focus(); })()`);
    await expect(page.engine.perform!(framed, { kind: 'press', key: 'x' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    await expect(page.engine.perform!(framed, { kind: 'focus' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(await page.browser.evaluate('document.getElementById("kept").value')).toBe('');
  });

  it('fails a press and a focus on an observed node of a frame whose page a navigation replaced as stale, and sends its key to nothing', async () => {
    await page.setContent(`<iframe id=f srcdoc='${attribute('<button>framed</button>')}'></iframe>`);
    await page.waitForFrames();
    const framed = (await page.nodes()).find((node) => node.name === 'framed')!.ref;
    await page.setContent('<input id=kept>');
    await page.browser.evaluate('document.getElementById("kept").focus()');
    await expect(page.engine.perform!(framed, { kind: 'press', key: 'x' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    await expect(page.engine.perform!(framed, { kind: 'focus' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(await page.browser.evaluate('document.getElementById("kept").value')).toBe('');
  });

  it('fails a press, a focus, a fill, and a tap on an observed node of a frame whose document a navigation replaced as stale, and sends its key to nothing', async () => {
    const framed = page.serve('/framed-before', '<input aria-label=field><button>go</button>');
    const after = page.serve('/framed-after', '<p>after</p>');
    await page.setContent(`<input id=kept><iframe id=f src=${JSON.stringify(framed)}></iframe>`);
    await page.waitForFrames();
    const nodes = await page.nodes();
    const field = nodes.find((node) => node.name === 'field')!.ref;
    const go = nodes.find((node) => node.name === 'go')!.ref;
    await page.browser.evaluate((url: string) => {
      document.querySelector('iframe')!.src = url;
      document.getElementById('kept')!.focus();
      return null;
    }, after);
    await expect.poll(() => page.browser.frameLocator('#f').locator('p').count(), { timeout: 10_000 }).toBe(1);
    const stale = { code: 'NODE_STALE', retryable: true };
    await expect(page.engine.perform!(field, { kind: 'press', key: 'x' }, page.op())).rejects.toMatchObject(stale);
    await expect(page.engine.perform!(field, { kind: 'focus' }, page.op())).rejects.toMatchObject(stale);
    await expect(page.engine.perform!(field, { kind: 'fill', value: 'x', sensitive: false }, page.op())).rejects.toMatchObject(stale);
    await expect(page.engine.perform!(go, { kind: 'tap' }, page.op())).rejects.toMatchObject(stale);
    expect(await page.browser.evaluate('document.getElementById("kept").value')).toBe('');
  });

  it('fails a press, a focus, a fill, and a tap on an observed node of a document of another origin of the same site as stale, and sends its key to nothing', async () => {
    const otherPort = await startPageServer();
    try {
      await page.setContent('<input aria-label=field><button>go</button>');
      const nodes = await page.nodes();
      const field = nodes.find((node) => node.name === 'field')!.ref;
      const go = nodes.find((node) => node.name === 'go')!.ref;
      await page.open(otherPort.serve('/other-port', '<input id=kept>'));
      await page.browser.evaluate('document.getElementById("kept").focus()');
      const stale = { code: 'NODE_STALE', retryable: true };
      await expect(page.engine.perform!(field, { kind: 'press', key: 'x' }, page.op())).rejects.toMatchObject(stale);
      await expect(page.engine.perform!(field, { kind: 'focus' }, page.op())).rejects.toMatchObject(stale);
      await expect(page.engine.perform!(field, { kind: 'fill', value: 'x', sensitive: false }, page.op())).rejects.toMatchObject(stale);
      await expect(page.engine.perform!(go, { kind: 'tap' }, page.op())).rejects.toMatchObject(stale);
      expect(await page.browser.evaluate('[location.origin, document.getElementById("kept").value]')).toEqual([otherPort.origin, '']);
    } finally {
      await otherPort.close();
    }
  });

  it('presses a located field in the document a navigation replaced its own with since the locate', async () => {
    const field = '<input id=i>';
    await page.setContent(field);
    // The first page call of a press is the read of its node.
    navigatedBeforeNext(elementAttached, page.serve('/replaced-before-press', field));
    await page.browser.locator('#i').press('x');
    expect(await page.browser.evaluate('[location.pathname, document.getElementById("i").value]')).toEqual(['/replaced-before-press', 'x']);
  });

  it('fails a press whose node Chromium refused after the read of it as stale, and reports one Firefox refused as possibly committed, its key sent to nothing', async () => {
    const field = '<input id=i>';
    await page.setContent(field);
    const [located] = await page.locate(bySelector('#i'));
    navigatedBeforeNext(focus, page.serve('/replaced-before-focus', field));
    // The focus is counted before it runs. Chromium refuses its node before it runs and sends no call twice; Firefox sends a call again that it sent to a first, empty document, so its refusal may follow a focus that ran.
    await expect(page.engine.perform!(located!.ref, { kind: 'press', key: 'x' }, page.op())).rejects.toMatchObject(
      onFirefox ? { code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false } : { code: 'NODE_STALE', retryable: true },
    );
    expect(await page.browser.evaluate('[location.pathname, document.getElementById("i").value]')).toEqual(['/replaced-before-focus', '']);
  });

  /** A control whose action polls: a select with no option `b` yet, and a field that is read-only still. */
  const POLLED = [
    ['select', '<select id=c><option>a</option></select>', '<select id=c><option>a</option><option>b</option></select>', selectOption, { kind: 'selectOption', value: 'b' }],
    ['fill', '<input id=c readonly>', '<input id=c>', fill, { kind: 'fill', value: 'b', sensitive: false }],
  ] as const;

  it.each(POLLED)('fails a %s that polls as stale once a navigation replaced its document between two tries, so a locator\'s lands in the document that replaced it', async (name, waiting, ready, _fn, action) => {
    await page.setContent(waiting);
    const [located] = await page.locate(bySelector('#c'));
    // Each try reads its node first: the navigation ends before the second try's read.
    navigatedBeforeNext(elementAttached, page.serve(`/replaced-between-tries-${name}`, waiting), 1);
    await expect(page.engine.perform!(located!.ref, action, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(await page.browser.evaluate('location.pathname')).toBe(`/replaced-between-tries-${name}`);
    vi.restoreAllMocks();
    await page.setContent(waiting);
    navigatedBeforeNext(elementAttached, page.serve(`/ready-between-tries-${name}`, ready), 1);
    const control = page.browser.locator('#c');
    await (action.kind === 'fill' ? control.fill('b') : control.selectOption('b'));
    expect(await page.browser.evaluate('[location.pathname, document.getElementById("c").value]')).toEqual([`/ready-between-tries-${name}`, 'b']);
  });

  it.each(POLLED)('fails a %s that polls as stale when Chromium refused its node after a later try\'s read of it, and reports one Firefox refused as possibly committed', async (name, waiting, _ready, fn, action) => {
    await page.setContent(waiting);
    const [located] = await page.locate(bySelector('#c'));
    navigatedBeforeNext(fn, page.serve(`/replaced-within-a-try-${name}`, waiting), 1);
    await expect(page.engine.perform!(located!.ref, action, page.op())).rejects.toMatchObject(
      onFirefox ? { code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false } : { code: 'NODE_STALE', retryable: true },
    );
    expect(await page.browser.evaluate('[location.pathname, document.getElementById("c").value]')).toEqual([`/replaced-within-a-try-${name}`, action.kind === 'fill' ? '' : 'a']);
  });

  it('reports a press whose focus handler navigated to another site and then blocked as possibly committed on Firefox, which replaces the document under the handler', async () => {
    let release = (): void => undefined;
    let handled = 0;
    const held = new Promise<void>((resolve) => {
      page.serve('/hold-focus', (_request, response) => {
        handled += 1;
        release = () => response.end();
        resolve();
      });
    });
    const other = page.serve('/after-focus', '<p>after</p>').replace('127.0.0.1', 'localhost');
    await page.setContent(`<input id=i><script>
      i.addEventListener('focus', () => {
        location.href = ${JSON.stringify(other)};
        const request = new XMLHttpRequest();
        request.open('GET', '/hold-focus', false);
        try { request.send(); } catch {}
      });
    </script>`);
    const [field] = await page.locate(bySelector('#i'));
    const press = page.engine.perform!(field!.ref, { kind: 'press', key: 'x' }, page.op());
    await held;
    try {
      // The handler ran, and Firefox fails the focus the moment the navigation takes its document away; Chromium keeps the document until the handler returns.
      if (onFirefox) await expect(press).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', message: expect.stringContaining('no such frame') });
    } finally {
      release();
    }
    if (!onFirefox) await press;
    expect(handled).toBe(1);
    // The handler's navigation ends before the next test starts its own.
    await expect.poll(() => page.browser.evaluate('location.pathname'), { timeout: 10_000 }).toBe('/after-focus');
  });

  it('fails a fill of a field the page replaced since its checks as stale, so the fill lands in the field that replaced it', async () => {
    await page.setContent('<input id=i>');
    const replace = 'document.getElementById("i").replaceWith(Object.assign(document.createElement("input"), { id: "i" }))';
    const [replaced] = await page.locate(bySelector('#i'));
    beforeNext(fill, replace);
    await expect(page.engine.perform!(replaced!.ref, { kind: 'fill', value: 'typed', sensitive: false }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    beforeNext(fill, replace);
    await page.browser.locator('#i').fill('typed');
    expect(await page.browser.evaluate('document.getElementById("i").value')).toBe('typed');
  });

  it('fails a select of a <select> the page replaced since its checks as stale, and selects only in the one that replaced it', async () => {
    const select = '<select id=s><option>a</option><option>b</option></select>';
    await page.setContent(select);
    const replace = `document.getElementById("s").outerHTML = ${JSON.stringify(select)}`;
    const [replaced] = await page.locate(bySelector('#s'));
    beforeNext(selectOption, replace);
    await expect(page.engine.perform!(replaced!.ref, { kind: 'selectOption', value: 'b' }, page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(await page.browser.evaluate('document.getElementById("s").value')).toBe('a');
    beforeNext(selectOption, replace);
    await page.browser.locator('#s').selectOption('b');
    expect(await page.browser.evaluate('document.getElementById("s").value')).toBe('b');
  });
});
