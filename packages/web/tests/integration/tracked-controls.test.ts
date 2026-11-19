/**
 * Edits of a form control whose state the page tracks, on both BiDi
 * browsers: a framework that puts a property of its own over `value` or
 * `checked` on the element (React's value tracker) records every write made
 * through it and takes the `input` that follows for no change. A fill, a
 * check, a select, and files sent as bytes each reach the control beneath
 * that property, so the page's change handler runs, as it does for a
 * person's edit.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';
import { setFileBytes } from '../../src/in-page/edits.ts';

/**
 * Page script: `track(node, property, event, host)` puts a property of the
 * page's own over `property` on `node` that records every write through it,
 * and on each `event` of `host` appends the state to `#seen` when it differs
 * from the last write recorded, as React decides whether to call `onChange`.
 */
const TRACK = `
  function track(node, property, event, host = node) {
    let native;
    for (let at = Object.getPrototypeOf(node); native === undefined; at = Object.getPrototypeOf(at)) native = Object.getOwnPropertyDescriptor(at, property);
    let tracked = String(native.get.call(node));
    Object.defineProperty(node, property, {
      configurable: true,
      get() { return native.get.call(this); },
      set(value) { tracked = String(value); native.set.call(this, value); },
    });
    host.addEventListener(event, () => {
      const now = String(native.get.call(node));
      if (now === tracked) return;
      tracked = now;
      document.getElementById('seen').textContent += property + '=' + now + ';';
    });
  }
`;

describe('tracked controls', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000 });
  });
  afterAll(async () => {
    await page.close();
  });

  /** What the page's tracker saw change, and what the control `#c` holds. */
  const seen = (property = 'value'): Promise<unknown> => page.browser.evaluate(`[document.getElementById('seen').textContent, Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, ${JSON.stringify(property)}).get.call(document.getElementById('c'))]`);

  it.each([
    ['range', '<input id=c type=range min=-30 max=30 step=1 value=0>', '12'],
    ['date', '<input id=c type=date>', '2024-01-02'],
    ['color', '<input id=c type=color>', '#ff0000'],
    ['time', '<input id=c type=time>', '12:30'],
    ['datetime-local', '<input id=c type=datetime-local>', '2024-01-02T12:30'],
    ['text', '<input id=c value=old>', 'hello'],
    ['number', '<input id=c type=number value=5>', '12'],
  ])('fills a %s input whose value the page tracks, and its input handler sees the change', async (_type, control, value) => {
    await page.setContent(`${control}<output id=seen></output><script>${TRACK}
      track(document.getElementById('c'), 'value', 'input');
    </script>`);
    await page.act(bySelector('#c'), { kind: 'fill', value, sensitive: false });
    expect(await seen()).toEqual([`value=${value};`, value]);
  });

  it('fills a textarea whose value the page tracks', async () => {
    await page.setContent(`<textarea id=c>old</textarea><output id=seen></output><script>${TRACK}
      track(document.getElementById('c'), 'value', 'input');
    </script>`);
    await page.act(bySelector('#c'), { kind: 'fill', value: 'two\nlines', sensitive: false });
    expect(await page.browser.evaluate('[document.getElementById("seen").textContent, Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").get.call(document.getElementById("c"))]')).toEqual(['value=two\nlines;', 'two\nlines']);
  });

  it('fills a slider of a class the page derived from the built-in input, which defines no value of its own', async () => {
    await page.setContent(`<output id=seen></output><script>${TRACK}
      customElements.define('tilt-slider', class extends HTMLInputElement {}, { extends: 'input' });
      const slider = Object.assign(document.createElement('input', { is: 'tilt-slider' }), { id: 'c', type: 'range', min: '-30', max: '30', value: '0' });
      document.body.prepend(slider);
      track(slider, 'value', 'input');
    </script>`);
    await page.act(bySelector('#c'), { kind: 'fill', value: '12', sensitive: false });
    expect(await seen()).toEqual(['value=12;', '12']);
  });

  it.each([
    ['checkbox', '<input id=c type=checkbox>'],
    ['radio', '<input id=c type=radio name=plan>'],
  ])('checks a %s whose checked state the page tracks, and its click handler sees the change', async (_type, control) => {
    await page.setContent(`${control}<output id=seen></output><script>${TRACK}
      track(document.getElementById('c'), 'checked', 'click');
    </script>`);
    await page.act(bySelector('#c'), { kind: 'check' });
    expect(await seen('checked')).toEqual(['checked=true;', true]);
  });

  it('unchecks a checkbox whose checked state the page tracks', async () => {
    await page.setContent(`<input id=c type=checkbox checked><output id=seen></output><script>${TRACK}
      track(document.getElementById('c'), 'checked', 'click');
    </script>`);
    await page.act(bySelector('#c'), { kind: 'uncheck' });
    expect(await seen('checked')).toEqual(['checked=false;', false]);
  });

  it('selects an option of a <select> whose options\' selected state the page tracks, and its change handler sees both change', async () => {
    await page.setContent(`<select id=c><option value=a selected>Alpha<option value=b>Beta<option value=c>Gamma</select><output id=seen></output><script>${TRACK}
      const select = document.getElementById('c');
      for (const option of select.options) track(option, 'selected', 'change', select);
      track(select, 'value', 'change');
    </script>`);
    await page.act(bySelector('#c'), { kind: 'selectOption', value: 'Beta' });
    expect(await page.browser.evaluate('[document.getElementById("seen").textContent, [...document.getElementById("c").selectedOptions].map((option) => option.value)]')).toEqual(['selected=false;selected=true;value=b;', ['b']]);
  });

  it('gives a file input whose files the page tracks the files sent as bytes', async () => {
    await page.setContent(`<input id=c type=file><output id=seen></output><script>
      const input = document.getElementById('c');
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      window.writes = 0;
      Object.defineProperty(input, 'files', { configurable: true, get() { return native.get.call(this); }, set(files) { window.writes += 1; native.set.call(this, files); } });
      input.addEventListener('change', () => { document.getElementById('seen').textContent = [...native.get.call(input)].map((file) => file.name + ':' + file.size).join(','); });
    </script>`);
    await page.browser.evaluate(
      `(files) => (${setFileBytes.toString()})(document.getElementById('c'), files)`,
      [{ name: 'note.txt', type: 'text/plain', lastModified: 1, base64: Buffer.from('hello').toString('base64') }],
    );
    expect(await page.browser.evaluate('[document.getElementById("seen").textContent, window.writes]')).toEqual(['note.txt:5', 0]);
  });
});
