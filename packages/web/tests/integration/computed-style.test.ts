/** Computed node properties come from real elements, including frames and shadow roots. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComputedStyleProperty, SemanticNode } from '@e2e-dev/core/engine';
import { byRole, flatten, startWebSession, type WebSession } from '../helpers/web-session.ts';

/** Finds a listed node by its accessible name. */
function named(tree: SemanticNode, name: string): SemanticNode | undefined {
  return flatten(tree).find((node) => node.name === name);
}

describe('computed node style', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession();
  });
  afterAll(async () => {
    await page?.close();
  });

  /** The ref the next observation gives the node named `name`. */
  const observed = async (name: string) => named((await page.observe()).root, name)!.ref;

  it('reads current computed values of an observed node without changing the page', async () => {
    await page.setContent('<style>button { color: rgb(255, 0, 0); font-weight: 700; opacity: .5 }</style><button>Error</button>');
    const ref = await observed('Error');
    const properties = ['color', 'font-weight', 'opacity', 'visibility'] as const;
    await expect(page.engine.readStyle!(ref, properties, page.op())).resolves.toEqual({
      color: 'rgb(255, 0, 0)', 'font-weight': '700', opacity: '0.5', visibility: 'visible',
    });
    await page.browser.evaluate(() => { document.querySelector('button')!.style.color = 'blue'; return null; });
    await expect(page.engine.readStyle!(ref, ['color'], page.op())).resolves.toEqual({ color: 'rgb(0, 0, 255)' });
    expect(await page.browser.evaluate(() => document.querySelector('button')!.textContent)).toBe('Error');
    await page.browser.evaluate(() => { document.querySelector('button')!.remove(); return null; });
    await expect(page.engine.readStyle!(ref, properties, page.op())).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('keeps the element binding when a similar element replaces it', async () => {
    await page.setContent('<button>Original</button>');
    const old = await observed('Original');
    await page.browser.evaluate(() => { document.querySelector('button')!.outerHTML = '<button>Original</button>'; return null; });
    await expect(page.engine.readStyle!(old, ['color'], page.op())).rejects.toMatchObject({ code: 'NODE_STALE' });
    const current = await observed('Original');
    await expect(page.engine.readStyle!(old, ['color'], page.op())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect(page.engine.readStyle!(current, ['display'], page.op())).resolves.toEqual({ display: 'inline-block' });
  });

  it('reads styles in a closed shadow root and rejects unsafe properties before resolving a ref', async () => {
    await page.setContent('<x-message></x-message>');
    await page.browser.evaluate(() => {
      document.querySelector('x-message')!.attachShadow({ mode: 'closed' }).innerHTML = '<button style="color: rgb(1, 2, 3)">Shadow error</button>';
      return null;
    });
    const ref = await observed('Shadow error');
    await expect(page.engine.readStyle!(ref, ['color'], page.op())).resolves.toEqual({ color: 'rgb(1, 2, 3)' });
    for (const style of [['content'], ['background-image'], ['--token']]) {
      await expect(page.engine.readStyle!({ id: 'absent', revision: '' }, style as ComputedStyleProperty[], page.op()))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    const controller = new AbortController();
    controller.abort();
    await expect(page.engine.readStyle!(ref, ['color'], { ...page.op(), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('uses the owning document for a node in a frame', async () => {
    await page.setContent('<iframe title="Error frame" srcdoc="<button style=\'color: rgb(4, 5, 6)\'>Framed error</button>"></iframe>');
    await page.waitForFrames();
    const ref = await observed('Framed error');
    await expect(page.engine.readStyle!(ref, ['color'], page.op())).resolves.toEqual({ color: 'rgb(4, 5, 6)' });
  });

  it('refuses a locator ref, since style targets are observation refs', async () => {
    await page.setContent('<button>Located</button>');
    const [located] = await page.locate(byRole('button'));
    await expect(page.engine.readStyle!(located!.ref, ['color'], page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: false });
  });

  it('reports a navigation that replaced an observed node as retryable NODE_STALE', async () => {
    await page.setContent('<button>Before navigation</button>');
    const ref = await observed('Before navigation');
    await page.setContent('<button>After navigation</button>');
    await expect(page.engine.readStyle!(ref, ['color'], page.op())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });
});
