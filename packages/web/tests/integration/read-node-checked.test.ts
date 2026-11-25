/**
 * The real reader takes a native control's checked and selected state from
 * the control, and aria-* only where there is none, and reads a checkbox's or
 * radio's value apart from its checked state.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SemanticNode } from '@e2e-dev/core/engine';
import { captureDocument } from '../../src/observation.ts';
import { readSemanticsFunction } from '../../src/in-page/read-semantics.ts';
import { SECURE_FIELD_SELECTOR } from '../../src/read-node.ts';
import { Published } from '../helpers/published.ts';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

/** One observation of the page through the same capture the engine uses, keyed by test id. */
async function captureByTestId(): Promise<Map<string | undefined, SemanticNode>> {
  let nextId = 1;
  const published = new Published();
  const { tree } = await captureDocument(
    {
      testIdAttribute: 'data-testid',
      site: undefined,
      reserveIds: (count) => { const first = nextId; nextId += count; return first; },
      commit: published.commit,
    },
    page,
    { framePath: [], budget: 100, deadline: Date.now() + 10_000, signal: new AbortController().signal },
  );
  published.dispose();
  const nodes: SemanticNode[] = [];
  const walk = (node: SemanticNode) => { nodes.push(node); for (const child of node.children ?? []) walk(child); };
  walk(tree);
  return new Map(nodes.map((node) => [node.testId, node]));
}

describe('header scope', () => {
  it('does not re-walk the ancestors for each role token that needs context', async () => {
    await page.setContent('<!doctype html><body></body>');
    await page.evaluate(() => {
      let parent: Element = document.body;
      for (let depth = 0; depth < 16; depth += 1) {
        const wrapper = document.createElement('div');
        wrapper.setAttribute('role', 'treeitem listitem');
        parent.append(wrapper);
        parent = wrapper;
      }
      parent.insertAdjacentHTML('beforeend', '<header data-testid="deep">x</header>');
      const original = Element.prototype.getAttribute;
      const counted = globalThis as unknown as { attributeReads: number; originalGetAttribute: typeof original };
      counted.attributeReads = 0;
      counted.originalGetAttribute = original;
      Element.prototype.getAttribute = function getAttribute(this: Element, name: string) {
        counted.attributeReads += 1;
        return original.call(this, name);
      };
    });
    const options = { testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR, mode: { kind: 'ariaRole' as const } };
    let role: string | null;
    let reads: number;
    try {
      role = await page.getByTestId('deep').evaluate(readSemanticsFunction<typeof options.mode>, options);
      reads = await page.evaluate(() => (globalThis as unknown as { attributeReads: number }).attributeReads);
    } finally {
      await page.evaluate(() => {
        Element.prototype.getAttribute = (globalThis as unknown as { originalGetAttribute: typeof Element.prototype.getAttribute }).originalGetAttribute;
      });
    }
    expect(role).toBe('banner');
    expect(reads).toBeLessThan(5_000);
  });
});

describe('header scope with a shadowing form field', () => {
  it('reads a header in a form whose field is named parentElement without looping', async () => {
    await page.setContent('<form aria-label="Looped"><input name="parentElement"><header data-testid="looped">Site</header></form>');
    const options = { testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR, mode: { kind: 'ariaRole' as const } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const role = await Promise.race([
      page.getByTestId('looped').evaluate(readSemanticsFunction<typeof options.mode>, options),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('timed out'), 3_000); }),
    ]).finally(() => clearTimeout(timer));
    expect(role).toBe('banner');
  });
});

describe('exact region scope', () => {
  it('keeps a header under an exact role="region" from being the banner', async () => {
    await page.setContent('<div role="region"><header data-testid="r">Top</header></div><div role="Region"><header data-testid="R">Top</header></div>');
    const options = { testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR, mode: { kind: 'ariaRole' as const } };
    expect(await page.getByTestId('r').evaluate(readSemanticsFunction<typeof options.mode>, options)).not.toBe('banner');
    expect(await page.getByTestId('R').evaluate(readSemanticsFunction<typeof options.mode>, options)).toBe('banner');
  });
  it('folds ARIA tokens in ASCII only, as Chrome does', async () => {
    await page.setContent('<div role="lin\u212A" data-testid="k">Kelvin</div><div role="LINK" data-testid="l">Upper</div>');
    const options = { testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR, mode: { kind: 'ariaRole' as const } };
    expect(await page.getByTestId('k').evaluate(readSemanticsFunction<typeof options.mode>, options)).not.toBe('link');
    expect(await page.getByTestId('l').evaluate(readSemanticsFunction<typeof options.mode>, options)).toBe('link');
  });
});

describe('checked and selected', () => {
  it('lists closed-select choices but excludes explicitly hidden options and optgroups', async () => {
    await page.setContent(`
      <select aria-label="Plan">
        <option data-testid="visible" selected value="internal-token">Visible</option>
        <option data-testid="disabled" disabled>Disabled</option>
        <option data-testid="hidden" hidden>Hidden</option>
        <option data-testid="display" style="display:none">No display</option>
        <option data-testid="visibility" style="visibility:hidden">No visibility</option>
        <option data-testid="aria" aria-hidden="true">No aria</option>
        <optgroup hidden label="Hidden group"><option data-testid="group">Hidden group choice</option></optgroup>
        <optgroup style="visibility:hidden" label="Restored group"><option data-testid="restored" style="visibility:visible">Restored</option></optgroup>
      </select>
    `);
    const nodes = await captureByTestId();
    expect(nodes.get('visible')).toMatchObject({ name: 'Visible', states: { selected: true } });
    expect(nodes.get('visible')?.value).toBeUndefined();
    expect(nodes.get('visible')?.states?.hidden).toBeUndefined();
    expect(nodes.get('disabled')).toMatchObject({ name: 'Disabled', states: { disabled: true } });
    expect(nodes.has('restored')).toBe(true);
    expect(nodes.has('visibility')).toBe(true);
    for (const id of ['hidden', 'display', 'aria', 'group']) expect(nodes.has(id)).toBe(false);
    expect(await page.getByRole('option').allTextContents()).toEqual(['Visible', 'Disabled', 'No visibility', 'Restored']);
  });

  it('lists a checkbox or radio its own label draws over no box as shown, with its checked state', async () => {
    await page.setContent(`
      <style>.shrunk { opacity: 0; width: 0; height: 0; margin: 0; position: absolute }</style>
      <label><input class="shrunk" type="checkbox" data-testid="agree" checked>Agree</label>
      <label><input class="shrunk" type="radio" data-testid="large">Large</label>
      <input class="shrunk" type="checkbox" id="unlabelled" data-testid="hidden-label"><label for="unlabelled" style="display:none">Gone</label>
    `);
    const nodes = await captureByTestId();
    expect(nodes.get('agree')).toMatchObject({ role: 'checkbox', name: 'Agree', states: { checked: true } });
    expect(nodes.get('large')).toMatchObject({ role: 'radio', name: 'Large', states: { checked: false } });
    for (const id of ['agree', 'large']) expect(nodes.get(id)?.states?.hidden).not.toBe(true);
    expect(nodes.has('hidden-label')).toBe(false);
  });

  it('leaves out a box-less control no label of its own draws in a way a tap can click', async () => {
    await page.setContent(`
      <style>.shrunk { opacity: 0; width: 0; height: 0; margin: 0; padding: 0; border: 0; position: absolute }</style>
      <label><input class="shrunk" type="checkbox" data-testid="invisible" style="visibility:hidden">Invisible</label>
      <label><input class="shrunk" type="text" data-testid="text">Name</label>
      <skip-slot><input class="shrunk" type="checkbox" id="skipped" data-testid="skipped"></skip-slot>
      <label for="skipped">Skipped</label>
      <label style="display:contents"><input class="shrunk" type="checkbox" data-testid="contents"><span>Contents</span></label>
      <label><input class="shrunk" type="checkbox" data-testid="link">Accept <a href="#terms">the terms</a></label>
      <label role="button"><input class="shrunk" type="checkbox" data-testid="button-label">Button</label>
      <label role="link"><input class="shrunk" type="checkbox" data-testid="link-label">Link</label>
      <label role="Button"><input class="shrunk" type="checkbox" data-testid="button-label-upper">Button upper</label>
      <label role="LINK"><input class="shrunk" type="checkbox" data-testid="link-label-upper">Link upper</label>
      <label contenteditable><input class="shrunk" type="checkbox" data-testid="editable-label">Editable</label>
      <script>
        customElements.define('skip-slot', class extends HTMLElement {
          connectedCallback() {
            this.attachShadow({ mode: 'open' }).innerHTML = '<div style="content-visibility:hidden;width:50px;height:50px"><slot></slot></div>';
          }
        });
      </script>
    `);
    const nodes = await captureByTestId();
    for (const id of ['invisible', 'text', 'skipped', 'contents', 'link', 'button-label', 'link-label', 'button-label-upper', 'link-label-upper', 'editable-label']) {
      expect(nodes.has(id), id).toBe(false);
    }
  });

  it('applies the option limit to offered choices after hidden options are excluded', async () => {
    await page.setContent(`<select aria-label="Many choices">${'<option hidden>Excluded</option>'.repeat(60)}${Array.from({ length: 61 }, (_, index) => `<option data-testid="choice-${index}">Choice ${index}</option>`).join('')}</select>`);
    const nodes = await captureByTestId();
    expect(nodes.get('choice-0')?.name).toBe('Choice 0');
    expect(nodes.get('choice-59')?.name).toBe('Choice 59');
    expect(nodes.has('choice-60')).toBe(false);
    expect([...nodes.values()].filter((node) => node.role === 'option')).toHaveLength(60);
    expect(await page.getByRole('option').count()).toBe(61);
  });

  it('reads selected boolean values without case sensitivity while native option state wins', async () => {
    await page.setContent(`
      <div role="tablist">
        <button role="tab" aria-selected="TRUE" data-testid="upper">All</button>
        <button role="tab" aria-selected="TrUe" data-testid="mixed">Recent</button>
        <button role="tab" aria-selected="FALSE" data-testid="off">Archived</button>
      </div>
      <select aria-label="Plan" size="3">
        <option data-testid="native-on" selected aria-selected="FALSE">Team</option>
        <option data-testid="native-off" aria-selected="TRUE">Solo</option>
      </select>
      <div role="button" data-testid="embedded">Pick <div role="listbox"><div role="option" aria-selected="true">Chosen</div><div role="option" aria-selected="false">Other</div></div></div>
    `);
    const nodes = await captureByTestId();
    expect(nodes.get('upper')?.states?.selected).toBe(true);
    expect(nodes.get('mixed')?.states?.selected).toBe(true);
    expect(nodes.get('off')?.states?.selected).toBe(false);
    expect(nodes.get('native-on')?.states?.selected).toBe(true);
    expect(nodes.get('native-off')?.states?.selected).toBe(false);
    expect(nodes.get('embedded')?.name).toBe('Pick Chosen');
    expect(await page.getByRole('tab', { selected: true }).allTextContents()).toEqual(['All', 'Recent']);
    expect(await page.getByRole('button', { name: 'Pick Chosen', exact: true }).count()).toBe(1);
  });

  it('reads roles and checked, expanded, pressed, and disabled values without case sensitivity, as Chrome does', async () => {
    await page.setContent(`
      <div role="checkbox" aria-checked="True" tabindex="0" data-testid="checked">Remember me</div>
      <div role="Switch" aria-checked="TRUE" tabindex="0" data-testid="switch">Wi-Fi</div>
      <button aria-expanded="True" data-testid="expanded">Menu</button>
      <button aria-pressed="TRUE" data-testid="pressed">Bold</button>
      <h3 aria-disabled="TrUe" data-testid="disabled">Archived</h3>
      <div role="Button" tabindex="0" data-testid="role">Save</div>
      <header data-testid="page-header">Site</header>
      <div role="Article" aria-label="Post"><header data-testid="article-header">Post header</header></div>
      <div role="group ARTICLE"><header data-testid="upper-fallback-header">Site header</header></div>
      <div role="group article"><header data-testid="lower-fallback-header">Site header</header></div>
      <div role="Region" aria-label="R1"><header data-testid="mixed-region-header">Region header</header></div>
      <div role="REGION"><header data-testid="upper-region-header">Region header</header></div>
      <div role="button" data-testid="embedded">Pick <div role="listbox"><div role="option" aria-selected="TRUE">Chosen</div><div role="option" aria-selected="false">Other</div></div></div>
    `);
    const nodes = await captureByTestId();
    expect(nodes.get('checked')?.states?.checked).toBe(true);
    expect(nodes.get('switch')).toMatchObject({ role: 'switch', states: { checked: true } });
    expect(nodes.get('expanded')?.states?.expanded).toBe(true);
    expect(nodes.get('pressed')?.states?.pressed).toBe(true);
    // A heading is outside the roles an inherited aria-disabled reaches, so only the element's own read counts.
    expect(nodes.get('disabled')).toMatchObject({ role: 'heading', states: { disabled: true } });
    expect(nodes.get('role')).toMatchObject({ role: 'button', name: 'Save' });
    // A header is the page banner unless a sectioning role scopes it, in any case.
    expect(nodes.get('page-header')?.role).toBe('banner');
    expect(nodes.get('article-header')?.role).not.toBe('banner');
    // Only an ancestor's first recognized role token scopes a header, as Chrome reads it.
    expect(nodes.get('upper-fallback-header')?.role).toBe('banner');
    expect(nodes.get('lower-fallback-header')?.role).toBe('banner');
    // Chrome never scopes a header by region; only the lowercase token Playwright's [role=region] matches does.
    expect(nodes.get('mixed-region-header')?.role).toBe('banner');
    expect(nodes.get('upper-region-header')?.role).toBe('banner');
    expect(nodes.get('embedded')?.name).toBe('Pick Chosen');
  });

  it('excludes uppercase hidden subtrees from observations and names but reads hidden references whole', async () => {
    await page.setContent(`
      <div aria-hidden="TRUE"><button data-testid="hidden" aria-hidden="false">Hidden action</button></div>
      <button data-testid="save">Save<span aria-hidden="TrUe"> decoration</span></button>
      <button data-testid="shown" aria-hidden="FALSE">Shown</button>
      <button data-testid="referenced" aria-labelledby="reference">Fallback</button>
      <div aria-hidden="TRUE"><span id="reference">Label <i style="display:none">whole</i></span></div>
    `);
    const nodes = await captureByTestId();
    expect(nodes.has('hidden')).toBe(false);
    expect(nodes.get('save')?.name).toBe('Save');
    expect(nodes.get('shown')?.name).toBe('Shown');
    expect(nodes.get('referenced')?.name).toBe('Label whole');
    expect(await page.getByRole('button', { name: 'Save', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Hidden action', exact: true }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Label whole', exact: true }).count()).toBe(1);
  });

  it('reads a native checkbox, radio, and option from the control even when a stale aria attribute disagrees, as Playwright does', async () => {
    await page.setContent(`
      <input type="checkbox" data-testid="stale-off" aria-checked="false" checked aria-label="Stale off">
      <input type="checkbox" data-testid="stale-on" aria-checked="true" aria-label="Stale on">
      <input type="radio" name="r" data-testid="radio-stale-off" aria-checked="false" checked aria-label="Radio stale off">
      <input type="radio" name="r2" data-testid="radio-stale-on" aria-checked="true" aria-label="Radio stale on">
      <input type="checkbox" data-testid="plain-on" checked aria-label="Plain on">
      <input type="checkbox" data-testid="plain-off" aria-label="Plain off">
      <div role="checkbox" aria-checked="true" data-testid="aria-on" tabindex="0">Aria on</div>
      <div role="switch" aria-checked="false" data-testid="aria-off" tabindex="0">Aria off</div>
      <select data-testid="select" aria-label="Plan" size="3">
        <option data-testid="option-stale-off" aria-selected="false" selected>Team</option>
        <option data-testid="option-stale-on" aria-selected="true">Solo</option>
      </select>
      <div role="tablist"><button role="tab" aria-selected="true" data-testid="tab">All</button></div>
    `);
    const nodes = await captureByTestId();
    const checked = (testId: string) => nodes.get(testId)?.states?.checked;
    const selected = (testId: string) => nodes.get(testId)?.states?.selected;

    expect(checked('stale-off')).toBe(true);
    expect(checked('stale-on')).toBe(false);
    expect(checked('radio-stale-off')).toBe(true);
    expect(checked('radio-stale-on')).toBe(false);
    expect(checked('plain-on')).toBe(true);
    expect(checked('plain-off')).toBe(false);
    expect(checked('aria-on')).toBe(true);
    expect(checked('aria-off')).toBe(false);
    expect(selected('option-stale-off')).toBe(true);
    expect(selected('option-stale-on')).toBe(false);
    expect(selected('tab')).toBe(true);

    for (const testId of ['stale-off', 'stale-on', 'radio-stale-off', 'radio-stale-on', 'plain-on', 'plain-off', 'aria-on', 'aria-off']) {
      expect(await page.getByTestId(testId).isChecked(), testId).toBe(checked(testId));
    }
  });
});

describe('a checkable control\'s value', () => {
  it('reads the value attribute, `on` by default, whatever the checked state, as Playwright\'s inputValue does', async () => {
    await page.setContent(`
      <input type="checkbox" data-testid="default-on" checked aria-label="Default on">
      <input type="checkbox" data-testid="default-off" aria-label="Default off">
      <input type="checkbox" data-testid="custom" value="yes" aria-label="Custom">
      <input type="radio" name="plan" data-testid="radio" value="monthly" aria-label="Monthly">
      <input type="radio" name="plan" data-testid="radio-default" aria-label="Default radio">
    `);
    const testIds = ['default-on', 'default-off', 'custom', 'radio', 'radio-default'];
    const options = { testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR, mode: { kind: 'node' as const } };
    const values = await Promise.all(
      testIds.map(async (id) => (await page.getByTestId(id).evaluate(readSemanticsFunction<typeof options.mode>, options)).value),
    );
    expect(values).toEqual(['on', 'on', 'yes', 'monthly', 'on']);
    for (const [index, testId] of testIds.entries()) {
      expect(await page.getByTestId(testId).inputValue(), testId).toBe(values[index]);
    }
    // The tree drops the token, as it drops an option's value; the checked state says what matters.
    const nodes = await captureByTestId();
    expect(testIds.map((testId) => nodes.get(testId)?.value)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
