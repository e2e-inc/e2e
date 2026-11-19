/**
 * An element's parent in the flat tree, read through a closed shadow root:
 * a slot of one component assigned to a slot of another is that slot's
 * child, and what the first slot holds sits under both.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { byRole, startWebSession, type WebSession } from '../helpers/web-session.ts';

/**
 * `<my-card>` renders its children through its own slot inside a
 * `<fancy-part>`, whose closed root wraps its slot in `wrapper`.
 */
const components = (wrapper: string): string => `<script>
  customElements.define('fancy-part', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(wrapper)}; }
  });
  customElements.define('my-card', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<fancy-part><slot></slot></fancy-part>'; }
  });
</script>`;

describe('the flat tree through a closed root', () => {
  let page: WebSession;

  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await page.close();
  });

  it('takes a tap on a closed root\'s button whose label reaches it through another component\'s slot', async () => {
    const button = '<button style="padding: 0; border: 0" onclick="document.title = \'Clicked\'"><slot></slot></button>';
    await page.setContent(`${components(button)}<my-card><span style="display: block; width: 120px; height: 40px">Save</span></my-card>`);
    await page.act(byRole('button', 'Save'), { kind: 'tap' });
    expect(await page.browser.evaluate(() => document.title)).toBe('Clicked');
  });

  it('leaves out what another component\'s slot carries into an inert part of a closed root', async () => {
    await page.setContent(`${components('<div inert><slot></slot></div>')}<my-card><button>Behind</button></my-card><button>Live</button>`);
    expect((await page.nodes()).filter((node) => node.role === 'button').map((node) => node.name)).toEqual(['Live']);
  });
});
