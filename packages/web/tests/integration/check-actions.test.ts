/**
 * `check` and `uncheck` against a real page, for both callers the engine acts
 * for: a test's deterministic step and the agent acting on what it observed. A control the app replaces or navigates away from once it is
 * picked took the click, so the action is done; a control the click never
 * reached stays a stale node, one that commits its state after a timer is
 * waited for, and one the click never changes fails at the deadline.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KINDS, targetOf, type Target } from '../helpers/action-target.ts';
import { attribute } from '../helpers/frames.ts';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';
import type { LocatorAction, SemanticNode } from '@e2e-dev/core/engine';

let session: WebSession;
let origin: string;

beforeAll(async () => {
  session = await startWebSession({ startAttempt: false });
  origin = session.origin;
  session.serve('/', '<label><input type="radio" name="plan" id="pro" onchange="location.href = \'/next\'">Pro</label>');
  session.serve('/next', '<p>Next page</p>');
});

afterAll(async () => {
  await session.close();
});

beforeEach(async () => {
  await session.startAttempt();
});

/** A refusal waits out the whole deadline, so the cases that expect one take a short one. */
const REFUSAL_TIMEOUT_MS = 500;
/** The budget of a check that waits it out for a state that never changes. */
const UNCHANGED_TIMEOUT_MS = 2_000;

/** Performs one action and returns the contract error it failed with, as the engine reports it. */
async function perform(target: Target, action: LocatorAction, timeoutMs = 5_000): Promise<Error | undefined> {
  try {
    await session.engine.perform!(target.ref, action, { ...session.op(timeoutMs), origin: target.origin });
    return undefined;
  } catch (cause) {
    return cause as Error;
  }
}

/** The text of the first element `selector` matches. */
function textOf(selector: string): Promise<string | null> {
  return session.browser.evaluate((target: string) => document.querySelector(target)?.textContent ?? null, selector);
}

/** Whether the input `selector` matches is checked. */
function isChecked(selector: string): Promise<boolean> {
  return session.browser.evaluate((target: string) => document.querySelector<HTMLInputElement>(target)!.checked, selector);
}

/** The attribute `name` of the first element `selector` matches. */
function attributeOf(selector: string, name: string): Promise<string | null> {
  return session.browser.evaluate(
    ({ target, named }: { target: string; named: string }) => document.querySelector(target)!.getAttribute(named),
    { target: selector, named: name },
  );
}

/** Clicks the page saw, counted in the page. */
function clicks(): Promise<number> {
  return session.browser.evaluate(() => (window as unknown as { clicks: number }).clicks);
}

const COUNT_CLICKS = '<script>window.clicks = 0; document.addEventListener("click", () => window.clicks++, true)</script>';

describe.each(KINDS)('for the %s', (kind) => {
  it('checks a radio the app replaces with its selected view', async () => {
    await session.setContent(`
      <div id="plan"><label><input type="radio" name="plan" id="pro"
        onchange="document.getElementById('plan').innerHTML = '<p>Pro selected</p>'">Pro</label></div>`);
    expect(await perform(await targetOf(session, kind, '#pro'), { kind: 'check' })).toBeUndefined();
    expect(await textOf('#plan')).toBe('Pro selected');
  });

  it('leaves what replaced the control to the next read, even an unchecked copy', async () => {
    await session.setContent(`
      <div id="terms"><label><input type="checkbox" id="box"
        onchange="document.getElementById('terms').innerHTML = '<label><input type=checkbox id=box>Agree</label>'">Agree</label></div>`);
    expect(await perform(await targetOf(session, kind, '#box'), { kind: 'check' })).toBeUndefined();
    expect(await isChecked('#box')).toBe(false);
  });

  it('checks a radio that navigates on change', async () => {
    await session.open(`${origin}/`);
    expect(await perform(await targetOf(session, kind, '#pro'), { kind: 'check' })).toBeUndefined();
    await session.browser.waitForURL(`${origin}/next`);
  });

  it('checks and unchecks a checkbox, and clicks nothing already in the wanted state', async () => {
    await session.setContent(`${COUNT_CLICKS}<label><input type="checkbox" id="box">Notify</label>`);
    const target = await targetOf(session, kind, '#box');
    expect(await perform(target, { kind: 'check' })).toBeUndefined();
    expect(await perform(target, { kind: 'check' })).toBeUndefined();
    expect(await isChecked('#box')).toBe(true);
    expect(await perform(target, { kind: 'uncheck' })).toBeUndefined();
    expect(await isChecked('#box')).toBe(false);
    expect(await clicks()).toBe(2);
  });

  it('checks an ARIA checkbox', async () => {
    await session.setContent(`
      <div role="checkbox" id="box" aria-checked="false" tabindex="0"
        onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))">Notify</div>`);
    expect(await perform(await targetOf(session, kind, '#box'), { kind: 'check' })).toBeUndefined();
    expect(await attributeOf('#box', 'aria-checked')).toBe('true');
  });

  it('waits for a controlled checkbox that commits its state after a timer', async () => {
    await session.setContent(`
      <label><input type="checkbox" id="box"
        onclick="const box = this; const next = box.checked; event.preventDefault();
          setTimeout(() => { box.checked = next; }, 300)">Notify</label>`);
    expect(await perform(await targetOf(session, kind, '#box'), { kind: 'check' })).toBeUndefined();
    expect(await isChecked('#box')).toBe(true);
  });

  it('waits for a switch whose aria-checked flips after a timer', async () => {
    await session.setContent(`
      <button role="switch" id="toggle" aria-checked="true"
        onclick="setTimeout(() => this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true')), 300)">Wi-Fi</button>`);
    expect(await perform(await targetOf(session, kind, '#toggle'), { kind: 'uncheck' })).toBeUndefined();
    expect(await attributeOf('#toggle', 'aria-checked')).toBe('false');
  });

  it('fails a rejected click on a control a later re-render replaces', async () => {
    await session.setContent(`
      <div id="terms"><label><input type="checkbox" id="box" onclick="event.preventDefault();
        setTimeout(() => { document.getElementById('terms').innerHTML = '<label><input type=checkbox id=box>Agree</label>'; }, 300)">Agree</label></div>`);
    expect(await perform(await targetOf(session, kind, '#box'), { kind: 'check' })).toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: 'check clicked the control but its checked state did not change before the control was replaced',
    });
  });

  it('fails a click that left the control as it was', async () => {
    await session.setContent('<label><input type="checkbox" id="box" onclick="event.preventDefault()">Locked</label>');
    expect(await perform(await targetOf(session, kind, '#box'), { kind: 'check' }, UNCHANGED_TIMEOUT_MS)).toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: 'check clicked the control but its checked state did not change',
    });
  });

  it('refuses to uncheck a radio without clicking it', async () => {
    await session.setContent(`${COUNT_CLICKS}<label><input type="radio" name="plan" id="pro" checked>Pro</label>`);
    expect(await perform(await targetOf(session, kind, '#pro'), { kind: 'uncheck' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(await clicks()).toBe(0);
  });

  it('unchecks an ARIA radio by clicking it, leaving the radio behavior to its script', async () => {
    await session.setContent(`
      <div role="radio" id="pro" aria-checked="true" tabindex="0"
        onclick="this.setAttribute('aria-checked', 'false')">Pro</div>`);
    expect(await perform(await targetOf(session, kind, '#pro'), { kind: 'uncheck' })).toBeUndefined();
    expect(await attributeOf('#pro', 'aria-checked')).toBe('false');
  });

  it('fails an ARIA radio whose click keeps it checked, naming the radio group', async () => {
    await session.setContent('<div role="radio" id="pro" aria-checked="true" tabindex="0">Pro</div>');
    expect(await perform(await targetOf(session, kind, '#pro'), { kind: 'uncheck' }, UNCHANGED_TIMEOUT_MS)).toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: expect.stringContaining('another radio in its group'),
    });
  });

  it('refuses a control that cannot be checked', async () => {
    await session.setContent('<button id="go">Go</button>');
    expect(await perform(await targetOf(session, kind, '#go'), { kind: 'check' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
  });
});

describe('a control gone before the click', () => {
  it('stays a retryable stale node: nothing was dispatched', async () => {
    await session.setContent('<label><input type="checkbox" id="box">Notify</label>');
    const target = await targetOf(session, 'agent', '#box');
    await session.browser.evaluate(() => { document.getElementById('box')!.remove(); return null; });
    expect(await perform(target, { kind: 'check' })).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });
});

const ELEMENT_PLUS_CSS = `
.el-radio-button{outline:none;display:inline-block;position:relative}
.el-radio-button__original-radio{opacity:0;z-index:-1;outline:none;position:absolute}
.el-radio-button__inner{white-space:nowrap;vertical-align:middle;background:#fff;border:1px solid #dcdfe6;line-height:1;cursor:pointer;display:inline-block;position:relative;padding:8px 15px}
.el-checkbox{cursor:pointer;display:inline-flex;align-items:center;position:relative}
.el-checkbox__input{white-space:nowrap;cursor:pointer;outline:none;display:inline-flex;position:relative}
.el-checkbox__original{opacity:0;z-index:-1;outline:none;width:0;height:0;margin:0;position:absolute}
.el-checkbox__inner{display:inline-block;position:relative;border:1px solid #dcdfe6;width:14px;height:14px;background:#fff;z-index:1}
.el-radio{cursor:pointer;display:inline-flex;align-items:center;position:relative}
.el-radio__input{white-space:nowrap;cursor:pointer;outline:none;display:inline-flex;position:relative}
.el-radio__original{opacity:0;z-index:-1;outline:none;margin:0;position:absolute;top:0;bottom:0;left:0;right:0}
.el-radio__inner{border:1px solid #dcdfe6;border-radius:100%;width:14px;height:14px;background:#fff;position:relative;display:inline-block}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10}
`;

const ELEMENT_PLUS_CONTROLS = `
<label class="el-radio-button"><input class="el-radio-button__original-radio" type="radio" name="mode" id="install"><span class="el-radio-button__inner">安装</span></label>
<label class="el-radio-button"><input class="el-radio-button__original-radio" type="radio" name="mode" id="remove"><span class="el-radio-button__inner">卸载</span></label>
<label class="el-checkbox"><span class="el-checkbox__input"><input class="el-checkbox__original" type="checkbox" id="agree"><span class="el-checkbox__inner"></span></span><span class="el-checkbox__label">Agree</span></label>
<label class="el-radio"><span class="el-radio__input"><input class="el-radio__original" type="radio" name="size" id="large"><span class="el-radio__inner"></span></span><span class="el-radio__label">Large</span></label>
`;

const ELEMENT_PLUS_PAGE = `<style>${ELEMENT_PLUS_CSS}</style>${ELEMENT_PLUS_CONTROLS}`;

const ELEMENT_PLUS_CASES = [
  ['radio-button', '#install'],
  ['checkbox', '#agree'],
  ['radio', '#large'],
] as const;

/** The page's URL. */
function urlOf(): Promise<string> {
  return session.browser.evaluate(() => location.href);
}

describe.each(KINDS)('a control its own label covers, for the %s', (kind) => {
  it.each(ELEMENT_PLUS_CASES)('checks an Element Plus %s', async (_, selector) => {
    await session.setContent(ELEMENT_PLUS_PAGE);
    expect(await perform(await targetOf(session, kind, selector), { kind: 'check' })).toBeUndefined();
    expect(await isChecked(selector)).toBe(true);
  });

  it.each(ELEMENT_PLUS_CASES)('taps an Element Plus %s', async (_, selector) => {
    await session.setContent(ELEMENT_PLUS_PAGE);
    expect(await perform(await targetOf(session, kind, selector), { kind: 'tap' })).toBeUndefined();
    expect(await isChecked(selector)).toBe(true);
  });

  it('unchecks an Element Plus checkbox, and refuses an Element Plus radio without clicking it', async () => {
    await session.setContent(`${COUNT_CLICKS}${ELEMENT_PLUS_PAGE}`);
    await session.browser.evaluate(() => {
      for (const id of ['agree', 'large']) (document.getElementById(id) as HTMLInputElement).checked = true;
      return null;
    });
    expect(await perform(await targetOf(session, kind, '#agree'), { kind: 'uncheck' })).toBeUndefined();
    expect(await isChecked('#agree')).toBe(false);
    const before = await clicks();
    expect(await perform(await targetOf(session, kind, '#large'), { kind: 'uncheck' })).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(await isChecked('#large')).toBe(true);
    expect(await clicks()).toBe(before);
  });

  it.each(ELEMENT_PLUS_CASES)('still refuses an Element Plus %s under a modal', async (_, selector) => {
    await session.setContent(`${ELEMENT_PLUS_PAGE}<div class="modal"></div>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(session, kind, selector), action, REFUSAL_TIMEOUT_MS)).toMatchObject({ code: 'NOT_ACTIONABLE' });
      expect(await isChecked(selector)).toBe(false);
    }
  });

  it.each(ELEMENT_PLUS_CASES)('waits out a loading mask over an Element Plus %s', async (_, selector) => {
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      await session.setContent(`${ELEMENT_PLUS_PAGE}<div class="modal"></div>
        <script>setTimeout(() => document.querySelector('.modal').remove(), 300)</script>`);
      expect(await perform(await targetOf(session, kind, selector), action)).toBeUndefined();
      expect(await isChecked(selector)).toBe(true);
    }
  });

  it.each(ELEMENT_PLUS_CASES)('waits for an Element Plus %s in a dialog that opens later', async (_, selector) => {
    for (const display of ['display:none', 'visibility:hidden']) {
      for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
        await session.setContent(`<style>${ELEMENT_PLUS_CSS}</style><div id="dialog" style="${display}">${ELEMENT_PLUS_CONTROLS}</div>
          <script>setTimeout(() => document.getElementById('dialog').removeAttribute('style'), 300)</script>`);
        expect(await perform(await targetOf(session, kind, selector), action)).toBeUndefined();
        expect(await isChecked(selector)).toBe(true);
      }
    }
  });

  it('still refuses a radio whose label covers it from outside the label box', async () => {
    await session.setContent(`
      <label style="display:inline-block;width:60px;height:20px">Pick<input type="radio" id="r"
        style="position:absolute;left:200px;top:100px;opacity:0;z-index:-1"><span
        style="position:absolute;left:190px;top:90px;width:40px;height:40px;background:#fff"></span></label>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(session, kind, '#r'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: expect.stringContaining('intercepts pointer events'),
      });
      expect(await isChecked('#r')).toBe(false);
    }
  });

  it('checks a boxless checkbox through its first visible label, past a hidden one', async () => {
    await session.setContent(`
      <input type="checkbox" id="c" style="display:none">
      <label for="c" style="display:none">A</label>
      <label for="c">B</label>`);
    expect(await perform(await targetOf(session, kind, '#c'), { kind: 'check' })).toBeUndefined();
    expect(await isChecked('#c')).toBe(true);
  });

  it('checks a boxless checkbox past a label hidden by visibility, which keeps its box', async () => {
    await session.setContent(`
      <input type="checkbox" id="c" style="display:none">
      <label for="c" style="visibility:hidden">A</label>
      <label for="c">B</label>`);
    expect(await perform(await targetOf(session, kind, '#c'), { kind: 'check' })).toBeUndefined();
    expect(await isChecked('#c')).toBe(true);
  });

  it('still refuses a radio under a link in its own label, and follows no link', async () => {
    await session.setContent(`<style>${ELEMENT_PLUS_CSS}</style>
      <label class="el-radio-button"><input class="el-radio-button__original-radio" type="radio" name="mode" id="install">
        <a href="#went" class="el-radio-button__inner">安装</a></label>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(session, kind, '#install'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: expect.stringContaining('intercepts pointer events'),
      });
      expect(await isChecked('#install')).toBe(false);
      expect(await urlOf()).not.toContain('#went');
    }
  });

  it('still refuses a boxless checkbox whose visible label has a link at its centre', async () => {
    await session.setContent(`
      <input type="checkbox" id="c" style="display:none">
      <label for="c" style="display:inline-block"><a href="#went">Terms</a></label>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(session, kind, '#c'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: expect.stringContaining('not visible'),
      });
      expect(await isChecked('#c')).toBe(false);
      expect(await urlOf()).not.toContain('#went');
    }
  });

  it('still refuses an Element Plus radio-button a disabled fieldset holds', async () => {
    await session.setContent(`<style>${ELEMENT_PLUS_CSS}</style><fieldset disabled>${ELEMENT_PLUS_CONTROLS}</fieldset>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(session, kind, '#install'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: expect.stringContaining('not enabled'),
      });
      expect(await isChecked('#install')).toBe(false);
    }
  });

  it('still refuses a boxless checkbox whose every label is hidden', async () => {
    await session.setContent(`
      <input type="checkbox" id="c" style="display:none">
      <label for="c" style="display:none">A</label>`);
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(session, kind, '#c'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: `${action.kind} did not become actionable in time: the control and its labels are not visible`,
      });
      expect(await isChecked('#c')).toBe(false);
    }
  });

  it('still refuses a disabled Element Plus radio-button', async () => {
    await session.setContent(ELEMENT_PLUS_PAGE.replace('id="install"', 'id="install" disabled'));
    for (const action of [{ kind: 'check' }, { kind: 'tap' }] as const) {
      expect(await perform(await targetOf(session, kind, '#install'), action, REFUSAL_TIMEOUT_MS)).toMatchObject({ code: 'NOT_ACTIONABLE' });
      expect(await isChecked('#install')).toBe(false);
    }
  });

  it('checks an Element Plus radio-button inside a shadow root', async () => {
    await session.setContent(`<div id="host"></div><script>
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(ELEMENT_PLUS_PAGE)};
    </script>`);
    expect(await perform(await targetOf(session, kind, '#install'), { kind: 'check' })).toBeUndefined();
    expect(await session.browser.evaluate(() => document.getElementById('host')!.shadowRoot!.querySelector<HTMLInputElement>('#install')!.checked)).toBe(true);
  });

  it('checks an Element Plus radio-button inside a frame', async () => {
    await session.setContent(`<p>Outer</p><iframe srcdoc="${attribute(ELEMENT_PLUS_PAGE)}"></iframe>`);
    await session.waitForFrames();
    expect(await perform(await targetOf(session, kind, { kind: 'frame', selector: 'iframe', source: bySelector('#install') }), { kind: 'check' })).toBeUndefined();
    expect(await session.browser.evaluate(() => document.querySelector('iframe')!.contentDocument!.querySelector<HTMLInputElement>('#install')!.checked)).toBe(true);
  });

  it('clicks nothing when cancelled while its stand-in read is in flight', async () => {
    for (const [selector, action] of [['#install', { kind: 'tap' }], ['#install', { kind: 'check' }], ['#plain', { kind: 'tap' }]] as const) {
      await session.setContent(`${ELEMENT_PLUS_PAGE}<input type="checkbox" id="plain">`);
      const target = await targetOf(session, kind, selector);
      // Holds the page's main thread, so the read waits behind it until after the abort.
      await session.browser.evaluate(() => {
        setTimeout(() => {
          const until = Date.now() + 400;
          while (Date.now() < until);
        }, 0);
        return null;
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('cancelled')), 100);
      await expect(session.engine.perform!(target.ref, action, { ...session.op(2_000), signal: controller.signal, origin: target.origin })).rejects.toThrow();
      expect(await isChecked(selector)).toBe(false);
    }
  });
});

describe('a checkbox or radio an observation lists over no box', () => {
  it('takes a tap on its listed node, so the walk lists none a tap cannot reach', async () => {
    await session.setContent(`<style>${ELEMENT_PLUS_CSS}</style>
      <label class="el-checkbox"><span class="el-checkbox__input"><input class="el-checkbox__original" type="checkbox" id="agree"><span class="el-checkbox__inner"></span></span><span class="el-checkbox__label">Agree</span></label>
      <label class="el-checkbox"><span class="el-checkbox__input"><input class="el-checkbox__original" type="radio" id="small"><span class="el-checkbox__inner"></span></span><span class="el-checkbox__label">Small</span></label>
      <label style="display:contents"><input class="el-checkbox__original" type="checkbox" id="contents"><span class="el-checkbox__inner"></span>Contents</label>
      <label class="el-checkbox"><span class="el-checkbox__input"><input class="el-checkbox__original" type="checkbox" id="terms"><span class="el-checkbox__inner"></span></span><span class="el-checkbox__label">Accept <a href="#went">the Terms and Conditions</a></span></label>`);
    const nodes: SemanticNode[] = await session.nodes();
    const listed = nodes.filter((node) => node.role === 'checkbox' || node.role === 'radio');
    expect(listed.map((node) => node.name)).toEqual(['Agree', 'Small']);
    const selectors: Record<string, string> = { Agree: '#agree', Small: '#small' };
    for (const node of listed) {
      const selector = selectors[node.name ?? '']!;
      expect(await session.browser.evaluate((target: string) => document.querySelector(target)!.getBoundingClientRect().width, selector), selector).toBe(0);
      expect(await perform({ origin: 'agent', ref: node.ref }, { kind: 'tap' }), selector).toBeUndefined();
      expect(await isChecked(selector), selector).toBe(true);
    }
    // The one a `display: contents` label holds is left out; a tap on the label text sets it.
    const text = nodes.find((node) => node.text === 'Contents');
    expect(text).toBeDefined();
    expect(await perform({ origin: 'agent', ref: text!.ref }, { kind: 'tap' })).toBeUndefined();
    expect(await isChecked('#contents')).toBe(true);
  });
});
