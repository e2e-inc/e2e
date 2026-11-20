/**
 * The reader's `hidden` state across shadow boundaries, which `isVisible()`,
 * `toBeVisible()`, and `toBeHidden()` read: content a closed `<details>`
 * folds away and content under `content-visibility: hidden` are hidden in the
 * flat tree, so a shadow tree under a closed `<details>` and an element
 * slotted into one, or into a closed root, read hidden the way Playwright
 * reads them. The agent's tree leaves the same buttons out.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from '@e2e-dev/core/engine';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../../src/closed-shadow.ts';
import { captureDocument } from '../../src/observation.ts';
import { readSemanticsFunction } from '../../src/in-page/read-semantics.ts';
import { EXACT_LABEL_SELECTOR_ENGINE_SOURCE } from '../../src/label-selector.ts';
import { READ_SELECTOR_ENGINE_SOURCE } from '../../src/read-selector.ts';
import { SECURE_FIELD_SELECTOR } from '../../src/read-node.ts';
import { SHOWN_SELECTOR_ENGINE_SOURCE } from '../../src/shown-selector.ts';

let browser: Browser;
let context: BrowserContext;
let page: Page;

const READ_OPTIONS = {
  testIdAttribute: 'data-testid',
  secureFieldSelector: SECURE_FIELD_SELECTOR,
  mode: { kind: 'node' as const },
};

const PAGE = `
  <details><summary>Light</summary><button id="light-in-closed">Light</button></details>
  <details><summary>Shadow</summary><x-host></x-host></details>
  <x-acc><button id="slotted">Slotted</button></x-acc>
  <x-acc-closed><button id="slotted-closed">Slotted closed</button></x-acc-closed>
  <x-sum><button id="in-summary-slot" slot="s">In summary slot</button><button id="in-body-slot">In body slot</button></x-sum>
  <details><summary><x-summary-host></x-summary-host></summary>body</details>
  <details open><summary>Open</summary><x-open-host></x-open-host></details>
  <x-cv-closed><button id="cv-closed">Closed slotted</button></x-cv-closed>
  <x-cv-open><button id="cv-open">Open slotted</button></x-cv-open>
  <x-sum-closed><button id="closed-summary-slot" slot="s">Closed summary slot</button><button id="closed-body-slot">Closed body slot</button></x-sum-closed>
  <x-manual><button id="manual-body">Manual body</button><button id="manual-summary">Manual summary</button></x-manual>
  <details><summary>First</summary><summary><button id="second-summary">Second summary</button></summary></details>
  <details><div><summary><button id="nested-summary">Nested summary</button></summary></div><summary><button id="direct-summary">Direct summary</button></summary></details>
  <x-svg-slot><button id="svg-named" slot="s">Past an SVG slot</button></x-svg-slot>
  <x-dup-slot><button id="dup-named" slot="d">First of two slots</button></x-dup-slot>
  <x-svg-first><button id="svg-first">Past an SVG slot, folded</button></x-svg-first>
  <x-nul-slot><button id="nul-named">Named with a NUL</button></x-nul-slot>
  <details id="foreign-summary-details"><button id="foreign-summary-body">Foreign summary body</button></details>
  <div id="foreign-host"></div>
  <style>.expanded::details-content { content-visibility: visible; }</style>
  <details class="expanded"><summary>CSS accordion</summary><button id="expanded-light">Expanded light</button><x-expanded-host></x-expanded-host></details>
  <x-cv-contents-closed><button id="cv-contents-closed">Contents closed</button></x-cv-contents-closed>
  <x-cv-contents-open><button id="cv-contents-open">Contents open</button></x-cv-contents-open>
  <x-cv-inline-closed><button id="cv-inline-closed">Inline closed</button></x-cv-inline-closed>
  <x-cv-contents-direct></x-cv-contents-direct>
  <x-acc-shown><button id="slotted-shown">Slotted shown</button></x-acc-shown>
  <x-acc-shown-closed><button id="slotted-shown-closed">Slotted shown closed</button></x-acc-shown-closed>
  <table><tr><td style="content-visibility:hidden"><button id="cv-td">Cell button</button></td></tr></table>
  <table><tr style="content-visibility:hidden"><td><button id="cv-tr">Row button</button></td></tr></table>
  <div style="display:contents;content-visibility:hidden">Loose text under a box-less wrapper</div>
  <script>
    const define = (name, mode, html) => customElements.define(name, class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode }).innerHTML = html; }
    });
    define('x-host', 'open', '<button id="shadow-in-closed">Shadow</button>');
    define('x-acc', 'open', '<details><summary>Acc</summary><slot></slot></details>');
    define('x-acc-closed', 'closed', '<details><summary>Acc</summary><slot></slot></details>');
    define('x-sum', 'open', '<details><summary><slot name="s"></slot></summary><slot></slot></details>');
    define('x-summary-host', 'open', '<button id="shadow-in-summary">In summary</button>');
    define('x-open-host', 'open', '<button id="shadow-in-open">In open</button>');
    const skipping = '<div style="content-visibility:hidden;width:200px;height:40px"><slot></slot></div>';
    define('x-cv-closed', 'closed', skipping);
    define('x-cv-open', 'open', skipping);
    define('x-svg-slot', 'closed', '<details><summary>Svg</summary><svg><slot name="s"></slot></svg></details><slot name="s"></slot>');
    define('x-svg-first', 'closed', '<svg><slot></slot></svg><details><summary>Svg first</summary><slot></slot></details>');
    customElements.define('x-nul-slot', class extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'closed' });
        root.innerHTML = '<details><summary>Nul</summary><slot></slot></details><slot></slot>';
        const [folded, shown] = root.querySelectorAll('slot');
        folded.setAttribute('name', '\\uFFFD');
        shown.setAttribute('name', '\\u0000');
        this.querySelector('#nul-named').setAttribute('slot', '\\u0000');
      }
    });
    const foreignDetails = document.querySelector('#foreign-summary-details');
    const htmlSummary = document.createElement('summary');
    htmlSummary.innerHTML = '<button id="html-summary-after-foreign">HTML summary after a foreign one</button>';
    foreignDetails.prepend(document.createElementNS('urn:e2e:not-html', 'summary'), htmlSummary);
    define('x-dup-slot', 'closed', '<details><summary>Dup</summary><slot name="d"></slot></details><slot name="d"></slot>');
    const foreign = document.createElementNS('urn:e2e:not-html', 'details');
    foreign.innerHTML = '<button id="in-foreign-details">In foreign details</button>';
    document.querySelector('#foreign-host').append(foreign);
    define('x-sum-closed', 'closed', '<details><summary><slot name="s"></slot></summary><slot></slot></details>');
    define('x-expanded-host', 'open', '<button id="expanded-shadow">Expanded shadow</button>');
    // content-visibility skips the contents of an element with a box it can contain; these have none.
    define('x-cv-contents-closed', 'closed', '<div style="content-visibility:hidden;display:contents"><slot></slot></div>');
    define('x-cv-contents-open', 'open', '<div style="content-visibility:hidden;display:contents"><slot></slot></div>');
    const shownBody = '<style>details::details-content { content-visibility: visible; }</style><details><summary>Shown</summary><slot></slot></details>';
    define('x-acc-shown', 'open', shownBody);
    define('x-acc-shown-closed', 'closed', shownBody);
    define('x-cv-contents-direct', 'open', '<div style="content-visibility:hidden;display:contents"><button id="cv-contents-direct">Contents direct</button></div>');
    define('x-cv-inline-closed', 'closed', '<span style="content-visibility:hidden"><slot></slot></span>');
    customElements.define('x-manual', class extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'closed', slotAssignment: 'manual' });
        root.innerHTML = '<svg><slot></slot></svg><details><summary><slot id="label"></slot></summary><slot id="body"></slot></details>';
        root.getElementById('label').assign(this.querySelector('#manual-summary'));
        root.getElementById('body').assign(this.querySelector('#manual-body'));
      }
    });
  </script>
`;

beforeAll(async () => {
  browser = await chromium.launch();
  context = await browser.newContext();
  // The engine opens closed roots the same way, so the reader can walk them.
  await context.addInitScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT);
  page = await context.newPage();
  await page.setContent(PAGE);
});

afterAll(async () => {
  await browser.close();
});

/** The reader's `hidden` state for `selector` on `on`, next to what Playwright says of the same element. */
async function hiddenOf(on: Page, selector: string): Promise<{ reader: boolean; playwright: boolean }> {
  const locator = on.locator(selector);
  const raw = await locator.evaluate(readSemanticsFunction<typeof READ_OPTIONS.mode>, READ_OPTIONS);
  return { reader: raw.states.hidden, playwright: await locator.isHidden() };
}

function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

describe('visibility across shadow boundaries, in the flat tree', () => {
  it.each([
    ['a light button under closed details', '#light-in-closed', true],
    ['a shadow button under closed details', '#shadow-in-closed', true],
    ['a button slotted into closed details in an open root', '#slotted', true],
    ['a button slotted into closed details in a closed root', '#slotted-closed', true],
    ['a button slotted into the summary of closed details', '#in-summary-slot', false],
    ['a button slotted into the body of closed details', '#in-body-slot', true],
    ['a shadow button in the summary of closed details', '#shadow-in-summary', false],
    ['a shadow button under open details', '#shadow-in-open', false],
    ['a button slotted under content-visibility: hidden in a closed root', '#cv-closed', true],
    ['a button slotted under content-visibility: hidden in an open root', '#cv-open', true],
    ['a button slotted by name into the summary of closed details in a closed root', '#closed-summary-slot', false],
    ['a button slotted into the body of closed details in a closed root', '#closed-body-slot', true],
    ['a button assigned by hand into the summary of closed details in a closed root', '#manual-summary', false],
    ['a button assigned by hand into the body of closed details in a closed root', '#manual-body', true],
    ['a button in a second summary of closed details', '#second-summary', true],
    ['a button in a summary that is not a child of closed details', '#nested-summary', true],
    ['a button in the first child summary of closed details, after a nested one', '#direct-summary', false],
    ['a button slotted into an HTML slot of a closed root, past an SVG element named slot under closed details', '#svg-named', false],
    ['a button slotted into the first of two slots of its name in a closed root, under closed details', '#dup-named', true],
    ['a button slotted into an HTML slot under closed details in a closed root, after an SVG element named slot', '#svg-first', true],
    ['a button slotted by a name holding U+0000 into a shown slot of a closed root', '#nul-named', false],
    ['a button in the first HTML summary of closed details, after a summary element that is not HTML', '#html-summary-after-foreign', false],
    ['a button in the body of closed details whose first child is a summary element that is not HTML', '#foreign-summary-body', true],
    ['a light button in closed details whose body CSS shows', '#expanded-light', false],
    ['a shadow button in closed details whose body CSS shows', '#expanded-shadow', false],
    ['a button slotted under content-visibility: hidden on display: contents in a closed root', '#cv-contents-closed', false],
    ['a button slotted under content-visibility: hidden on display: contents in an open root', '#cv-contents-open', false],
    ['a button slotted under content-visibility: hidden on an inline element in a closed root', '#cv-inline-closed', false],
    ['a shadow button under content-visibility: hidden on display: contents', '#cv-contents-direct', false],
    ['a button in a table row with content-visibility: hidden', '#cv-tr', false],
    ['a button slotted into closed details whose body CSS shows, in an open root', '#slotted-shown', false],
    ['a button slotted into closed details whose body CSS shows, in a closed root', '#slotted-shown-closed', false],
    ['a button under a details element that is not HTML', '#in-foreign-details', false],
  ])('%s', async (_case, selector, hidden) => {
    const locator = page.locator(selector);
    const raw = await locator.evaluate(readSemanticsFunction<typeof READ_OPTIONS.mode>, READ_OPTIONS);
    expect({ reader: raw.states.hidden, playwright: await locator.isHidden() }).toEqual({ reader: hidden, playwright: hidden });
  });

  it('lists only the buttons that render in the agent tree', async () => {
    let nextId = 1;
    const { tree } = await captureDocument(
      {
        testIdAttribute: 'data-testid',
        site: undefined,
        reserveIds: (count) => { const first = nextId; nextId += count; return first; },
        commit: () => undefined,
      },
      page,
      { framePath: [], budget: 200, deadline: Date.now() + 10_000, signal: new AbortController().signal },
    );
    const buttons = flatten(tree).filter((node) => node.role === 'button').map((node) => node.name);
    expect(buttons).toEqual(['In summary slot', 'In summary', 'In open', 'Closed summary slot', 'Manual summary', 'Direct summary', 'Past an SVG slot', 'Named with a NUL', 'HTML summary after a foreign one', 'In foreign details', 'Expanded light', 'Expanded shadow', 'Contents closed', 'Contents open', 'Inline closed', 'Contents direct', 'Slotted shown', 'Slotted shown closed', 'Row button']);
    expect(flatten(tree).some((node) => [node.name, node.text].some((text) => text?.includes('Loose text under a box-less wrapper')))).toBe(true);
  });

  it('hides a button under a closed details adopted from another frame', async () => {
    const other = await context.newPage();
    await other.setContent('<iframe srcdoc="<details><summary>Adopted</summary><button id=adopted>Adopted</button></details>"></iframe>');
    await other.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('details') != null);
    await other.evaluate(() => document.body.append(document.querySelector('iframe')!.contentDocument!.querySelector('details')!));
    expect(await hiddenOf(other, '#adopted')).toEqual({ reader: true, playwright: true });
    await other.evaluate(() => document.querySelector('details')!.setAttribute('open', ''));
    expect(await hiddenOf(other, '#adopted')).toEqual({ reader: false, playwright: false });
    await other.close();
  });

  it('lists the slots of a closed root once per read, however many children its host slots', async () => {
    const other = await context.newPage();
    const rows = Array.from({ length: 1000 }, (_, index) => `<span slot="s${index}">Row</span>`).join('') + '<span>Row</span>'.repeat(1000);
    const slots = Array.from({ length: 1000 }, (_, index) => `<slot name="s${index}"></slot>`).join('') + '<slot></slot>';
    await other.setContent(`<many-host>${rows}</many-host><script>
      customElements.define('many-host', class extends HTMLElement {
        constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<div>${slots}</div>'; }
      });
    </script>`);
    await other.evaluate(() => {
      const counts = { scans: 0, lists: 0 };
      (globalThis as unknown as { counts: typeof counts }).counts = counts;
      const scan = HTMLSlotElement.prototype.assignedElements;
      HTMLSlotElement.prototype.assignedElements = function (this: HTMLSlotElement, options?: AssignedNodesOptions) {
        counts.scans += 1;
        return scan.call(this, options);
      };
      const list = ShadowRoot.prototype.querySelectorAll;
      ShadowRoot.prototype.querySelectorAll = function (this: ShadowRoot, selectors: string) {
        if (selectors === 'slot') counts.lists += 1;
        return list.call(this, selectors);
      } as typeof list;
    });
    let nextId = 1;
    await captureDocument(
      {
        testIdAttribute: 'data-testid',
        site: undefined,
        reserveIds: (count) => { const first = nextId; nextId += count; return first; },
        commit: () => undefined,
      },
      other,
      { framePath: [], budget: 200, deadline: Date.now() + 10_000, signal: new AbortController().signal },
    );
    const expectAtMostOneList = ({ scans, lists }: { scans: number; lists: number }): void => {
      expect({ scans, listsAtMostOnce: lists <= 1 }).toEqual({ scans: 0, listsAtMostOnce: true });
    };
    const counts = (): Promise<{ scans: number; lists: number }> =>
      other.evaluate(() => {
        const { counts: current } = globalThis as unknown as { counts: { scans: number; lists: number } };
        const taken = { ...current };
        current.scans = 0;
        current.lists = 0;
        return taken;
      });
    expectAtMostOneList(await counts());
    // A locator reads each match in its own reader call.
    const spans = other.locator('many-host > span');
    for (let index = 0; index < 5; index += 1) {
      await spans.nth(index).evaluate(readSemanticsFunction<typeof READ_OPTIONS.mode>, READ_OPTIONS);
      expectAtMostOneList(await counts());
    }
    await other.close();
  });

  it('looks for the summary of a wide closed details once per read', async () => {
    const other = await context.newPage();
    // No summary, so every look walks all 2,000 children.
    await other.setContent(`<details>${'<span>Row</span>'.repeat(2000)}</details>`);
    await other.evaluate(() => {
      const counter = { reads: 0 };
      (globalThis as unknown as { counter: typeof counter }).counter = counter;
      for (const name of ['children', 'firstElementChild', 'nextElementSibling'] as const) {
        const property = Object.getOwnPropertyDescriptor(Element.prototype, name) ?? Object.getOwnPropertyDescriptor(Document.prototype, name)!;
        Object.defineProperty(Element.prototype, name, {
          configurable: true,
          get(this: Element) {
            if (this.localName === 'details' || this.parentElement?.localName === 'details') counter.reads += 1;
            return property.get!.call(this);
          },
        });
      }
    });
    let nextId = 1;
    await captureDocument(
      {
        testIdAttribute: 'data-testid',
        site: undefined,
        reserveIds: (count) => { const first = nextId; nextId += count; return first; },
        commit: () => undefined,
      },
      other,
      { framePath: [], budget: 3000, deadline: Date.now() + 10_000, signal: new AbortController().signal },
    );
    // One walk of the children, plus whatever else of the read steps through them; never one walk per child.
    expect(await other.evaluate(() => (globalThis as unknown as { counter: { reads: number } }).counter.reads)).toBeLessThanOrEqual(3 * 2000);
    await other.close();
  });

  it.each([
    ['shown', SHOWN_SELECTOR_ENGINE_SOURCE, '', 'each'],
    ['read', READ_SELECTOR_ENGINE_SOURCE, JSON.stringify({ testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR, token: 't' }), 'each'],
    ['label', EXACT_LABEL_SELECTOR_ENGINE_SOURCE, JSON.stringify({ value: 'Row', testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR }), 'once'],
  ])('reads the slots of a closed root once per %s selector operation, however many matches it reads', async (_engine, source, selector, calls) => {
    const other = await context.newPage();
    await other.setContent(`<many-host>${'<button>Row</button>'.repeat(1000)}</many-host><script>
      customElements.define('many-host', class extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: 'closed', slotAssignment: 'manual' });
          root.innerHTML = '<div><slot></slot></div>';
          root.querySelector('slot').assign(...this.children);
        }
      });
    </script>`);
    const work = await other.evaluate(({ source: engineSource, selector: body, calls: callStyle }) => {
      const counts = { assigned: 0, lists: 0 };
      const scan = HTMLSlotElement.prototype.assignedElements;
      HTMLSlotElement.prototype.assignedElements = function (this: HTMLSlotElement, options?: AssignedNodesOptions) {
        const found = scan.call(this, options);
        counts.assigned += found.length;
        return found;
      };
      const list = ShadowRoot.prototype.querySelectorAll;
      ShadowRoot.prototype.querySelectorAll = function (this: ShadowRoot, selectors: string) {
        if (selectors === 'slot') counts.lists += 1;
        return list.call(this, selectors);
      } as typeof list;
      // eslint-disable-next-line no-new-func
      const engine = (new Function(`return (${engineSource})()`) as () => { queryAll: (root: Element, selector: string) => Element[] })();
      // One selector operation: Playwright calls the engine once per candidate, synchronously.
      // The label engine reads every labelable candidate under one root in a single call.
      const matched = callStyle === 'once'
        ? engine.queryAll(document.documentElement, body)
        : Array.from(document.querySelectorAll('many-host > button')).flatMap((button) => engine.queryAll(button, body));
      return { read: matched.length > 0 || callStyle === 'once', ...counts };
    }, { source, selector, calls });
    expect(work).toEqual({ read: true, assigned: 1000, lists: 1 });
    await other.close();
  });

  it('reads slots again in the next selector operation, after the page moved an element to another slot', async () => {
    const other = await context.newPage();
    await other.setContent(`<moving-host><button id="moving">Moving</button></moving-host><script>
      customElements.define('moving-host', class extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: 'closed', slotAssignment: 'manual' });
          root.innerHTML = '<details><summary><slot id="label"></slot></summary><slot id="body"></slot></details>';
          root.getElementById('body').assign(this.querySelector('#moving'));
          window.moveToSummary = () => root.getElementById('label').assign(this.querySelector('#moving'));
        }
      });
      window.shown = (${SHOWN_SELECTOR_ENGINE_SOURCE})();
    </script>`);
    const shownNow = (): Promise<boolean> =>
      other.evaluate(() => (globalThis as unknown as { shown: { queryAll: (root: Element, selector: string) => Element[] } }).shown.queryAll(document.querySelector('#moving')!, '').length === 1);
    expect(await shownNow()).toBe(false);
    await other.evaluate(() => (globalThis as unknown as { moveToSummary: () => void }).moveToSummary());
    expect(await shownNow()).toBe(true);
    await other.close();
  });

  it('reads a table cell with content-visibility: hidden as skipping what is in it', async () => {
    // Chromium skips a table cell's contents, as checkVisibility() reports; Firefox and WebKit paint them.
    const raw = await page.locator('#cv-td').evaluate(readSemanticsFunction<typeof READ_OPTIONS.mode>, READ_OPTIONS);
    expect(raw.states.hidden).toBe(true);
  });
});
