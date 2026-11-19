/**
 * The reader's `hidden` state, which `isVisible()`, `toBeVisible()`, and
 * `toBeHidden()` read, is right on the cases a rect count alone gets wrong: a hidden SVG, a zero-size box, closed
 * `<details>` content, an empty `display: contents` element, skipped
 * `content-visibility` content, and an `aria-hidden` node that still paints.
 * The tree walk keeps `aria-hidden` subtrees out while it walks into a
 * `visibility: hidden` one a child shows again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from '@e2e-dev/core/engine';
import { byRole, byTestId, flatten, startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => {
  page = await startWebSession();
});

afterAll(async () => {
  await page.close();
});

/** The reader's `hidden` state for one element. */
async function hiddenOf(selector: string): Promise<boolean> {
  return (await page.readNode(selector)).states.hidden;
}

const PAGE = `
  <svg id="svg-hidden" width="40" height="40" style="visibility:hidden"><rect width="40" height="40"></rect></svg>
  <svg id="svg-shown" width="40" height="40" role="img" aria-label="Logo"><rect width="40" height="40"></rect></svg>
  <div id="zero" style="width:0;height:0;overflow:hidden"><button>Clipped</button></div>
  <div id="sized" style="width:40px;height:40px;overflow:hidden"><button>Shown</button></div>
  <details id="closed"><summary>More</summary><button id="in-closed">Inside closed</button></details>
  <details id="open" open><summary>More</summary><button id="in-open">Inside open</button></details>
  <details><summary>Outer</summary><details id="nested" open><summary>Inner</summary><button id="in-nested">Nested</button></details></details>
  <div id="contents-empty" style="display:contents"></div>
  <div id="contents-hidden-child" style="display:contents"><span style="display:none">gone</span></div>
  <div id="contents-painted" style="display:contents"><button>Painted</button></div>
  <div id="contents-text" style="display:contents">bare text</div>
  <div id="contents-hidden-element" style="display:contents;visibility:hidden"><span>hidden span</span></div>
  <div id="contents-shown-child" style="display:contents;visibility:hidden"><span style="visibility:visible">shown span</span></div>
  <div id="spinner" aria-hidden="true" style="width:40px;height:40px;background:#888">spinning</div>
  <div aria-hidden="true"><button id="under-aria-hidden">Decorative</button></div>
  <div id="skipping" style="content-visibility:hidden;width:50px;height:50px"><button id="skipped">Skipped</button></div>
  <skip-host id="skipping-host" style="content-visibility:hidden;display:block;width:50px;height:50px"><button id="skipped-slotted">Slotted</button></skip-host>
  <div id="vis-parent" style="visibility:hidden"><button id="vis-child" style="visibility:visible">Shown child</button></div>
  <label><input id="shrunk-checkbox" type="checkbox" style="opacity:0;width:0;height:0;margin:0;position:absolute">Agree</label>
  <script>
    customElements.define('skip-host', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div><slot></slot></div>'; }
    });
  </script>
`;

describe('visibility', () => {
  beforeAll(async () => {
    await page.setContent(PAGE);
  });

  it.each([
    ['an SVG with visibility: hidden', '#svg-hidden', true],
    ['a shown SVG', '#svg-shown', false],
    ['a zero-size box with clipped content', '#zero', true],
    ['the button clipped inside a zero-size box, which keeps a box of its own', '#zero button', false],
    ['a sized box', '#sized', false],
    ['a button inside closed details', '#in-closed', true],
    ['the summary of closed details', '#closed summary', false],
    ['a button inside open details', '#in-open', false],
    ['open details nested in the body of closed details', '#nested', true],
    ['the summary of details nested in closed details', '#nested summary', true],
    ['a button inside open details nested in closed details', '#in-nested', true],
    ['an empty display: contents element', '#contents-empty', true],
    ['a display: contents element whose only child is hidden', '#contents-hidden-child', true],
    ['a display: contents element with a painted child', '#contents-painted', false],
    ['a display: contents element with bare text', '#contents-text', false],
    ['a hidden display: contents element whose child inherits it', '#contents-hidden-element', true],
    ['a hidden display: contents element whose child is visible again', '#contents-shown-child', false],
    ['an aria-hidden spinner that paints', '#spinner', false],
    ['a button under an aria-hidden container', '#under-aria-hidden', false],
    ['a content-visibility: hidden element, which keeps its box', '#skipping', false],
    ['a button content-visibility: hidden skips', '#skipped', true],
    ['a button slotted under a content-visibility: hidden host', '#skipped-slotted', true],
    ['a visibility: hidden parent', '#vis-parent', true],
    ['a child that sets visibility: visible under a hidden parent', '#vis-child', false],
    ['a checkbox its label draws over no box, which the observation still lists', '#shrunk-checkbox', true],
  ])('%s', async (_case, selector, hidden) => {
    expect(await hiddenOf(selector)).toBe(hidden);
  });
});

describe('visibility beyond a range box', () => {
  it('hides text under a display: contents element whose visibility is hidden', async () => {
    await page.setContent('<div id="contents-hidden-text" style="display:contents;visibility:hidden">Invisible text</div>');
    expect(await hiddenOf('#contents-hidden-text')).toBe(true);
  });
});

describe('a role query on a display: contents element', () => {
  it.each([
    ['text that lays out a box', '<span id="target" role="button" style="display:contents">Save</span>', 1],
    ['text under a display: none ancestor', '<div style="display:none"><span id="target" role="button" style="display:contents">Save</span></div><p>x</p>', 0],
    ['text in its own visibility: hidden', '<span id="target" role="button" style="display:contents;visibility:hidden">Save</span><p>x</p>', 0],
    ['text a closed <details> folds away', '<details><summary>More</summary><span id="target" role="button" style="display:contents">Save</span></details>', 0],
    ['text a closed <details> folds away, under another display: contents element', '<details><summary>More</summary><div style="display:contents"><span id="target" role="button" style="display:contents">Save</span></div></details>', 0],
    ['text in the body of an open <details>', '<details open><summary>More</summary><span id="target" role="button" style="display:contents">Save</span></details>', 1],
    ['text in the summary of a closed <details>', '<details><summary>More <span id="target" role="button" style="display:contents">Save</span></summary><p>x</p></details>', 1],
    ['text a content-visibility: hidden ancestor skips', '<div style="content-visibility:hidden"><span id="target" role="button" style="display:contents">Save</span></div><p>x</p>', 0],
  ])('matches the element only while its hidden state reads false: %s', async (_case, html, count) => {
    await page.setContent(html);
    expect((await page.locate(byRole('button'))).length).toBe(count);
    expect(await hiddenOf('#target')).toBe(count === 0);
  });

  it('taps the one Save that shows beside one under a display: none ancestor', async () => {
    await page.setContent(`<div style="display:none"><span role="button" style="display:contents">Save</span></div>
      <button onclick="document.title = 'saved'">Save</button>`);
    await page.act(byRole('button', 'Save'), { kind: 'tap' });
    expect(await page.browser.evaluate(() => document.title)).toBe('saved');
  });
});

describe('content a closed <details> folds away across a shadow boundary', () => {
  /** A page whose light child `target` is slotted into the body of a `<details>` in its host's shadow root. */
  const slotted = (mode: string, open: string, target: string): string => `<fold-host>${target}</fold-host><script>
    customElements.define('fold-host', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: '${mode}' }).innerHTML = '<details${open}><summary>More</summary><slot></slot></details>'; }
    });
  </script>`;

  /** A page whose `target` is in the shadow root of a host in the body of a `<details>`. */
  const hosted = (mode: string, open: string, target: string): string => `<details${open}><summary>More</summary><fold-host></fold-host></details><script>
    customElements.define('fold-host', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: '${mode}' }).innerHTML = ${JSON.stringify(target)}; }
    });
  </script>`;

  const BUTTON = '<button data-testid="target">Go</button>';
  const CONTENTS = '<span data-testid="target" role="button" style="display:contents">Go</span>';

  /** What the page says of its target: its `hidden` state, how many buttons a role query finds, and how many an observation lists. */
  async function read(html: string): Promise<{ hidden: boolean; byRole: number; observed: number }> {
    await page.setContent(html);
    const [target] = await page.locate(byTestId('target'));
    return {
      hidden: target!.states?.hidden ?? false,
      byRole: (await page.locate(byRole('button', 'Go'))).length,
      observed: (await captureTree()).filter((node) => node.role === 'button' && node.name === 'Go').length,
    };
  }

  it.each([
    ['a button slotted into the <details> of an open shadow root', slotted, 'open', BUTTON],
    ['a button slotted into the <details> of a closed shadow root', slotted, 'closed', BUTTON],
    ['a display: contents button slotted into the <details> of an open shadow root', slotted, 'open', CONTENTS],
    ['a display: contents button slotted into the <details> of a closed shadow root', slotted, 'closed', CONTENTS],
    ['a button in the open shadow root of a host under <details>', hosted, 'open', BUTTON],
    ['a button in the closed shadow root of a host under <details>', hosted, 'closed', BUTTON],
    ['a display: contents button in the open shadow root of a host under <details>', hosted, 'open', CONTENTS],
    ['a display: contents button in the closed shadow root of a host under <details>', hosted, 'closed', CONTENTS],
  ])('hides %s while the <details> is closed', async (_case, build, mode, target) => {
    expect(await read(build(mode, '', target))).toEqual({ hidden: true, byRole: 0, observed: 0 });
    expect(await read(build(mode, ' open', target))).toEqual({ hidden: false, byRole: 1, observed: 1 });
  });

  it.each(['open', 'closed'])('shows a button slotted into the summary of a closed <details> in a shadow root: %s', async (mode) => {
    expect(await read(`<fold-host><button slot="label" data-testid="target">Go</button><p>Folded</p></fold-host><script>
      customElements.define('fold-host', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: '${mode}' }).innerHTML = '<details><summary><slot name="label"></slot></summary><slot></slot></details>'; }
      });
    </script>`)).toEqual({ hidden: false, byRole: 1, observed: 1 });
  });
});

describe('the bounding box', () => {
  /** The reader's rect for one element next to its laid-out box, null when it has no layout box. */
  async function boxOf(selector: string) {
    const raw = await page.readNode(selector);
    const layout = await page.browser.evaluate((target: string) => {
      const element = document.querySelector(target)!;
      if (element.getClientRects().length === 0) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }, selector);
    return { reader: raw.rect, layout };
  }

  it.each([
    ['display: none', '<div id="box" style="display:none">gone</div>', null],
    ['under a display: none ancestor', '<div style="display:none"><span id="box">gone</span></div>', null],
    ['an empty display: contents element', '<div id="box" style="display:contents"></div>', null],
    ['display: contents around text', '<div id="box" style="display:contents">text</div>', null],
    ['visibility: hidden, which keeps its box', '<div id="box" style="visibility:hidden;width:30px;height:20px"></div>', { width: 30, height: 20 }],
    ['a zero-size box', '<div id="box" style="width:0;height:0"></div>', { width: 0, height: 0 }],
  ])('%s', async (_case, html, size) => {
    await page.setContent(`<body style="margin:0">${html}</body>`);
    const { reader, layout } = await boxOf('#box');
    expect(reader).toEqual(layout);
    expect(reader === null ? null : { width: reader.width, height: reader.height }).toEqual(size);
  });
});

/** One observation of the page, frames included. */
async function captureTree(): Promise<SemanticNode[]> {
  return flatten((await page.observe()).root);
}

describe('the tree walk through a box with no size', () => {
  it('lists the fixed controls under a zero-height page and wrapper, and neither the wrapper nor the root as hidden', async () => {
    await page.setContent(`
      <nav aria-label="Floating" data-testid="wrapper">
        <button style="position:fixed;left:0;top:0;width:100px;height:30px">Reset</button>
      </nav>
    `);
    const nodes = await captureTree();
    expect(nodes[0]!.states?.hidden).toBeUndefined();
    expect(nodes.find((node) => node.role === 'button')?.name).toBe('Reset');
    expect(nodes.find((node) => node.testId === 'wrapper')).toBeUndefined();
  });

  it('lists the root of a page with no height of its own as shown, which a locate reads as hidden', async () => {
    await page.setContent('<style>html, body { margin: 0; height: 0 }</style><button style="position:fixed;left:0;top:0;width:100px;height:30px">Reset</button>');
    const nodes = await captureTree();
    expect(nodes[0]).toMatchObject({ role: 'document' });
    expect(nodes[0]!.states?.hidden).toBeUndefined();
    expect(nodes.find((node) => node.role === 'button')?.name).toBe('Reset');
    expect((await page.locate({ kind: 'selector', selector: 'html' }))[0]?.states?.hidden).toBe(true);
  });

  it('lists neither the document of a frame with no box nor the options of a select with none', async () => {
    await page.setContent(`
      <iframe style="width:0;height:0;border:0" srcdoc="<button>Pay</button>"></iframe>
      <iframe style="width:200px;height:100px" srcdoc="<button>Shown pay</button>"></iframe>
      <select aria-label="Folded" style="width:0;height:0;padding:0;border:0"><option>plain</option><option>warm</option></select>
      <select aria-label="Shown"><option>cool</option></select>
    `);
    await page.waitForFrames();
    const nodes = await captureTree();
    const buttons = nodes.filter((node) => node.role === 'button').map((node) => node.name);
    const options = nodes.filter((node) => node.role === 'option').map((node) => node.name);
    expect(buttons).toEqual(['Shown pay']);
    expect(options).toEqual(['cool']);
    expect(nodes.filter((node) => node.role === 'combobox').map((node) => node.name)).toEqual(['Shown']);
  });
});

describe('a frame\'s document', () => {
  it('places its boxes past the frame\'s border and padding, in the top viewport', async () => {
    await page.setContent('<iframe style="margin:13px;border:7px solid;padding:5px;width:200px;height:100px" srcdoc="<button>Framed</button>"></iframe>');
    await page.waitForFrames();
    const node = (await captureTree()).find((candidate) => candidate.name === 'Framed')!;
    const expected = await page.browser.evaluate(() => {
      const frame = document.querySelector('iframe')!;
      const style = getComputedStyle(frame);
      const outer = frame.getBoundingClientRect();
      const inner = frame.contentDocument!.querySelector('button')!.getBoundingClientRect();
      return {
        x: outer.x + frame.clientLeft + Number.parseFloat(style.paddingLeft) + inner.x,
        y: outer.y + frame.clientTop + Number.parseFloat(style.paddingTop) + inner.y,
        width: inner.width,
        height: inner.height,
      };
    });
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(node.rect![key]).toBeCloseTo(expected[key], 3);
  });
});

describe('an inert subtree', () => {
  it('leaves the tree, as Chrome drops it, while its node still reads visible', async () => {
    await page.setContent(`
      <main inert><h2>Behind the drawer</h2><button id="inert-save">Save</button></main>
      <button>Close drawer</button>
    `);
    const names = (await captureTree()).map((node) => node.name).filter((name) => name !== undefined);
    expect(names).toContain('Close drawer');
    expect(names).not.toContain('Save');
    expect(names).not.toContain('Behind the drawer');
    expect(await hiddenOf('#inert-save')).toBe(false);
  });

  it('lists nothing under an inert document root, and nothing slotted into an inert slot of a closed root', async () => {
    await page.setContent('<!doctype html><html inert><body><button>Whole page</button></body></html>');
    expect((await captureTree()).filter((node) => node.role === 'button')).toEqual([]);
    await page.setContent(`
      <inert-slot><button>Slotted</button></inert-slot>
      <button>Outside</button>
      <script>
        customElements.define('inert-slot', class extends HTMLElement {
          connectedCallback() { this.attachShadow({ mode: 'closed' }).innerHTML = '<div inert><slot></slot></div>'; }
        });
      </script>
    `);
    const buttons = (await captureTree()).filter((node) => node.role === 'button').map((node) => node.name);
    expect(buttons).toEqual(['Outside']);
  });
});

describe('an open modal dialog', () => {
  const buttonNames = async () => (await captureTree()).filter((node) => node.role === 'button').map((node) => node.name);

  it('leaves the page behind it out of the tree, while a read of a node behind it still calls it visible', async () => {
    await page.setContent(`
      <main><h2>Store</h2><button id="behind">Add to cart</button></main>
      <dialog id="consent"><p>We use cookies.</p><button>Accept</button></dialog>
      <script>document.getElementById('consent').showModal();</script>
    `);
    const names = (await captureTree()).map((node) => node.name).filter((name) => name !== undefined);
    expect(names).toContain('Accept');
    expect(names).not.toContain('Add to cart');
    expect(names).not.toContain('Store');
    expect(await hiddenOf('#behind')).toBe(false);
  });

  it('keeps the dialog holding focus when two were shown out of tree order, with no show order recorded', async () => {
    await page.setContent(`
      <dialog id="first"><button>First dialog</button></dialog>
      <dialog id="second"><button>Second dialog</button></dialog>
      <script>document.getElementById('second').showModal(); document.getElementById('first').showModal();</script>
    `);
    expect(await buttonNames()).toEqual(['First dialog']);
  });

  it('leaves the page alone for a dialog shown without a modal, and once a modal dialog closes', async () => {
    await page.setContent(`
      <button>Page button</button>
      <dialog id="plain"><button>Plain dialog</button></dialog>
      <dialog id="modal"><button>Modal dialog</button></dialog>
      <script>
        document.getElementById('plain').show();
        document.getElementById('modal').showModal();
        document.getElementById('modal').close();
      </script>
    `);
    expect(await buttonNames()).toEqual(['Page button', 'Plain dialog']);
  });
});

describe('the tree walk through hidden content', () => {
  it('walks into a visibility: hidden subtree for a child that shows again, and stops at aria-hidden and skipped content', async () => {
    await page.setContent(`
      <div style="visibility:hidden"><button>Hidden parent</button><div><button style="visibility:visible">Shown child</button></div></div>
      <div aria-hidden="true"><button>Decorative</button></div>
      <div style="content-visibility:hidden;width:50px;height:50px" data-testid="skipping">Skipped text<button>Skipped</button></div>
      <div style="display:contents;visibility:hidden"><button>Contents hidden</button></div>
    `);
    const nodes = await captureTree();
    const buttons = nodes.filter((node) => node.role === 'button');
    expect(buttons.map((node) => [node.name, node.states?.hidden])).toEqual([['Shown child', undefined]]);
    const skipping = nodes.find((node) => node.testId === 'skipping');
    expect(skipping?.states?.hidden).toBeUndefined();
    // The container keeps its box and paints none of its text, which innerText reads empty too.
    expect(skipping?.text).toBe('');
    expect(await page.browser.evaluate(() => document.querySelector<HTMLElement>('[data-testid="skipping"]')!.innerText)).toBe('');
  });
});
