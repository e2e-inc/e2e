/**
 * The page-side functions in `src/in-page/`, sent as source text the way
 * `devtools.ts` sends them, on real pages in Chromium. Electron's renderer
 * is Chromium, so the DOM they read is the same.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type ElementHandle, type Page } from 'playwright-core';
import { nodeOp, queryAll, type NodeOps } from '../../src/in-page/node-ops.ts';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

/** Runs `nodeOp` on the element a selector names, from its source text. */
async function run<K extends keyof NodeOps>(handle: ElementHandle, name: K, ...args: Parameters<NodeOps[K]>): Promise<ReturnType<NodeOps[K]>> {
  return await handle.evaluate((node, [source, op, values]) => new Function(`return (${source})`)()(node, op, values), [nodeOp.toString(), name, args] as const);
}

async function element(selector: string): Promise<ElementHandle> {
  const handle = await page.$(selector);
  if (handle === null) throw new Error(`no element matches ${selector}`);
  return handle;
}

describe('nodeOp', () => {
  it('reads disabled as Chromium does: a fieldset disables its controls, aria-disabled the nearest wins', async () => {
    await page.setContent(`
      <fieldset disabled><button id="in-fieldset">A</button><legend><a href="#" id="link">L</a></legend></fieldset>
      <div aria-disabled="true"><span id="marked">M</span><div aria-disabled="false"><span id="unmarked">U</span></div></div>
      <button id="hidden" style="visibility:hidden">H</button>`);
    expect(await run(await element('#in-fieldset'), 'checkEnabled', true)).toEqual({ ok: false, reason: 'it is disabled' });
    expect(await run(await element('#in-fieldset'), 'checkEnabled', false)).toEqual({ ok: true });
    expect(await run(await element('#link'), 'checkEnabled', true)).toEqual({ ok: true });
    expect(await run(await element('#marked'), 'checkEnabled', true)).toEqual({ ok: false, reason: 'it is disabled' });
    expect(await run(await element('#unmarked'), 'checkEnabled', true)).toEqual({ ok: true });
    expect(await run(await element('#hidden'), 'checkEnabled', false)).toEqual({ ok: false, reason: 'it is not visible' });
  });

  it('hit-tests through a slot and a shadow host, and names the element that covers the point', async () => {
    await page.setContent(`
      <div id="host"><button id="slotted" style="width:100px;height:40px">S</button></div>
      <button id="covered" style="position:absolute;left:0;top:100px;width:100px;height:40px">C</button>
      <div id="cover" style="position:absolute;left:0;top:100px;width:100px;height:40px"></div>`);
    await page.evaluate(() => {
      const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
      root.innerHTML = '<div><slot></slot></div>';
    });
    const slotted = await element('#slotted');
    const box = (await slotted.boundingBox())!;
    expect(await run(slotted, 'hitTest', box.x + 10, box.y + 10)).toEqual({ ok: true });
    expect(await run(await element('#covered'), 'hitTest', 10, 110)).toEqual({ ok: false, reason: 'another element (div#cover) would receive the click' });
  });

  it('takes a label over the field it names as a hit', async () => {
    await page.setContent(`<label for="field" style="display:block;width:100px;height:40px">Name</label><input id="field">`);
    expect(await run(await element('#field'), 'hitTest', 10, 10)).toEqual({ ok: true });
  });

  it('checks a field for editing and sets the value of an input that takes no typed text', async () => {
    await page.setContent(`<input id="text"><input id="ro" readonly><input id="date" type="date" value="2026-01-02"><input id="num" type="number"><div id="host" contenteditable="true">x</div><div id="plain">p</div>`);
    expect(await run(await element('#text'), 'checkEditable')).toEqual({ ok: true });
    expect(await run(await element('#ro'), 'checkEditable')).toEqual({ ok: false, reason: 'it is read-only' });
    expect(await run(await element('#host'), 'checkEditable')).toEqual({ ok: true });
    expect(await run(await element('#plain'), 'checkEditable')).toEqual({ ok: false, reason: 'it is not a text field' });
    expect(await run(await element('#text'), 'setValue', 'typed')).toBeNull();
    expect(await run(await element('#num'), 'setValue', 'abc')).toEqual({ ok: false, reason: 'the number input does not take "abc"' });
    // A malformed date is refused before the field loses what it held.
    expect(await run(await element('#date'), 'setValue', 'not a date')).toEqual({ ok: false, reason: 'the date input does not take "not a date"' });
    expect(await page.inputValue('#date')).toBe('2026-01-02');
    expect(await run(await element('#date'), 'setValue', '2026-03-04')).toEqual({ ok: true });
    expect(await page.inputValue('#date')).toBe('2026-03-04');
  });

  it('fills a range past its default bounds and an input of an unknown type, trimmed and in the case the input keeps', async () => {
    await page.setContent(`<input id="range" type="range" min="0" max="1000" step="50" value="100"><input id="odd" type="unknownkind"><input id="tint" type="color">`);
    expect(await run(await element('#range'), 'setValue', '750')).toEqual({ ok: true });
    expect(await page.inputValue('#range')).toBe('750');
    expect(await run(await element('#odd'), 'checkEditable')).toEqual({ ok: true });
    expect(await run(await element('#tint'), 'setValue', ' #FF8800 ')).toEqual({ ok: true });
    expect(await page.inputValue('#tint')).toBe('#ff8800');
  });

  it('fails a check on a node the document dropped, so the harness locates it again', async () => {
    await page.setContent(`<button id="gone">Gone</button>`);
    const gone = await element('#gone');
    await gone.evaluate((node) => node.parentNode?.removeChild(node));
    await expect(run(gone, 'checkEnabled', true)).rejects.toThrow(/Node is detached/);
  });

  it('says whether a file input takes several files, empties one, and tells a radio', async () => {
    await page.setContent(`<input id="one" type="file"><input id="many" type="file" multiple><input id="radio" type="radio"><div id="aria" role="radio"></div><input id="box" type="checkbox">`);
    expect(await run(await element('#one'), 'takesFiles', 2)).toEqual({ ok: false, reason: 'the file input takes one file, not 2: it has no multiple attribute' });
    expect(await run(await element('#many'), 'takesFiles', 2)).toEqual({ ok: true });
    await run(await element('#one'), 'clearFiles');
    expect(await run(await element('#radio'), 'isRadio')).toBe(true);
    expect(await run(await element('#aria'), 'isRadio')).toBe(true);
    expect(await run(await element('#box'), 'isRadio')).toBe(false);
  });

  it('reads a checked state from the input or the aria attributes, and null for none', async () => {
    await page.setContent(`<input id="box" type="checkbox" checked><div id="switch" role="switch" aria-checked="false"></div><button id="toggle" aria-pressed="true">T</button><div id="none"></div><div id="mixed" role="checkbox" aria-checked="mixed"></div>`);
    expect(await run(await element('#box'), 'readChecked')).toBe(true);
    expect(await run(await element('#switch'), 'readChecked')).toBe(false);
    expect(await run(await element('#toggle'), 'readChecked')).toBe(true);
    expect(await run(await element('#none'), 'readChecked')).toBeNull();
    // A mixed checkbox is not checked, so check() clicks it.
    expect(await run(await element('#mixed'), 'readChecked')).toBe(false);
  });

  it('finds an option by label, then text, value, or index, and refuses a missing or disabled one', async () => {
    await page.setContent(`<select id="pick"><option value="a">Apple</option><option value="b" label="Banana">ignored</option><optgroup disabled><option value="c">Cherry</option></optgroup></select>`);
    const pick = await element('#pick');
    expect(await run(pick, 'checkSelect', { label: 'Banana' })).toEqual({ ok: true });
    expect(await run(pick, 'checkSelect', { label: 'Cherry' })).toEqual({ ok: false, reason: 'option "Cherry" is disabled' });
    expect(await run(pick, 'checkSelect', { label: 'Durian' })).toEqual({ ok: false, reason: 'no option matches {"label":"Durian"}; the options are "Apple", "Banana", "Cherry"' });
    expect(await run(pick, 'selectOption', { value: 'b' })).toEqual({ ok: true });
    expect(await page.inputValue('#pick')).toBe('b');
    expect(await run(pick, 'selectOption', { index: 0 })).toEqual({ ok: true });
    expect(await page.inputValue('#pick')).toBe('a');
  });

  it('follows focus through open shadow roots, and stops at a closed one', async () => {
    await page.setContent(`<div id="open"></div><div id="closed"></div>`);
    await page.evaluate(() => {
      const open = document.querySelector('#open')!.attachShadow({ mode: 'open' });
      open.innerHTML = '<input id="inner">';
      (open.querySelector('#inner') as HTMLInputElement).focus();
    });
    const documentHandle = await page.evaluateHandle(() => window.document);
    const active = await documentHandle.evaluate((node, source) => new Function(`return (${source})`)()(node, 'activeUnder', []).id, nodeOp.toString());
    expect(active).toBe('inner');
    await page.evaluate(() => {
      const closed = document.querySelector('#closed')!.attachShadow({ mode: 'closed' });
      closed.innerHTML = '<input>';
      closed.querySelector('input')!.focus();
    });
    const host = await documentHandle.evaluate((node, source) => new Function(`return (${source})`)()(node, 'activeUnder', []).id, nodeOp.toString());
    expect(host).toBe('closed');
  });

  it('says which focused elements take typed text', async () => {
    await page.setContent(`<input id="text"><input id="box" type="checkbox"><textarea id="ro" readonly></textarea><div id="host" contenteditable="true"></div>`);
    expect(await run(await element('#text'), 'takesText')).toBe(true);
    expect(await run(await element('#box'), 'takesText')).toBe(false);
    expect(await run(await element('#ro'), 'takesText')).toBe(false);
    expect(await run(await element('#host'), 'takesText')).toBe(true);
  });
});

describe('queryAll', () => {
  it('matches in the document and in every open shadow root, one root at a time', async () => {
    await page.setContent(`<p class="hit">1</p><div id="host"></div>`);
    await page.evaluate(() => {
      const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
      root.innerHTML = '<p class="hit">2</p><div id="nested"></div>';
      root.querySelector('#nested')!.attachShadow({ mode: 'open' }).innerHTML = '<p class="hit">3</p>';
      document.body.appendChild(document.createElement('div')).attachShadow({ mode: 'closed' }).innerHTML = '<p class="hit">hidden</p>';
    });
    const texts = await page.evaluate((source) => (new Function(`return (${source})`)()('.hit') as Element[]).map((found) => found.textContent), queryAll.toString());
    expect(texts).toEqual(['1', '2', '3']);
    // A selector that crosses a root matches nothing: each root is matched on its own.
    const crossing = await page.evaluate((source) => (new Function(`return (${source})`)()('#host .hit') as Element[]).length, queryAll.toString());
    expect(crossing).toBe(0);
  });
});
