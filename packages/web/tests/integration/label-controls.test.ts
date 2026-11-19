/**
 * An edit of a `<label>` goes to the control it names, by `for` or by
 * holding it, as Playwright retargets one: `fill`, `clear`, `check`,
 * `uncheck`, and `selectOption`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';

/** A text field, a checkbox, and a select, each with a label that names it (`for`) or holds it (`wrap`). */
const PAGE = `<title>Labels</title>
<label id="for-text" for="text-a">Email</label><input id="text-a" value="old">
<label id="wrap-text">Name <input id="text-b" value="old"></label>
<label id="for-check" for="check-a">Agree</label><input id="check-a" type="checkbox">
<label id="wrap-check"><input id="check-b" type="checkbox"> Subscribe</label>
<label id="for-select" for="select-a">Size</label><select id="select-a"><option>A</option><option>B</option></select>
<label id="wrap-select">Color <select id="select-b"><option>A</option><option>B</option></select></label>
<label id="for-nothing" for="missing">Nothing</label>`;

let session: WebSession;

beforeAll(async () => {
  session = await startWebSession({ startAttempt: false });
});

afterAll(async () => {
  await session.close();
});

beforeEach(async () => {
  await session.startAttempt();
  await session.setContent(PAGE);
});

/** The value of the field, or the checked state of the checkbox, `selector` matches. */
function state(selector: string): Promise<string | boolean> {
  return session.browser.evaluate((target: string) => {
    const control = document.querySelector<HTMLInputElement | HTMLSelectElement>(target)!;
    return control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value;
  }, selector);
}

describe.each([['for', 'a'], ['wrap', 'b']] as const)('a label that names its control by %s', (kind, control) => {
  it('fills and clears the field', async () => {
    await session.act(bySelector(`#${kind}-text`), { kind: 'fill', value: 'hello', sensitive: false });
    expect(await state(`#text-${control}`)).toBe('hello');
    await session.act(bySelector(`#${kind}-text`), { kind: 'clear' });
    expect(await state(`#text-${control}`)).toBe('');
  });

  it('checks and unchecks the checkbox', async () => {
    await session.act(bySelector(`#${kind}-check`), { kind: 'check' });
    expect(await state(`#check-${control}`)).toBe(true);
    await session.act(bySelector(`#${kind}-check`), { kind: 'check' });
    expect(await state(`#check-${control}`)).toBe(true);
    await session.act(bySelector(`#${kind}-check`), { kind: 'uncheck' });
    expect(await state(`#check-${control}`)).toBe(false);
  });

  it('selects the option', async () => {
    await session.act(bySelector(`#${kind}-select`), { kind: 'selectOption', value: 'B' });
    expect(await state(`#select-${control}`)).toBe('B');
  });
});

it('refuses to fill a label that names no control', async () => {
  const [label] = await session.locate(bySelector('#for-nothing'));
  await expect(session.engine.perform!(label!.ref, { kind: 'fill', value: 'hello', sensitive: false }, { ...session.op(1_000), origin: 'test' })).rejects.toMatchObject({
    message: expect.stringContaining('Element is not an <input>, <textarea> or [contenteditable] element'),
  });
});

it('selects the option whose label the list shows, not one whose text a label attribute hides', async () => {
  await session.setContent(`<select id="s">
    <option value="0">Zero</option>
    <option value="1" label="Real label">Other text</option>
    <option value="2">Other   text</option>
    <option value="3">&nbsp;Padded</option>
  </select>`);
  await session.act(bySelector('#s'), { kind: 'selectOption', value: 'Other text' });
  expect(await state('#s')).toBe('2');
  await session.act(bySelector('#s'), { kind: 'selectOption', value: 'Real label' });
  expect(await state('#s')).toBe('1');
  // A non-breaking space is no part of the label a person reads.
  await session.act(bySelector('#s'), { kind: 'selectOption', value: 'Padded' });
  expect(await state('#s')).toBe('3');
});
