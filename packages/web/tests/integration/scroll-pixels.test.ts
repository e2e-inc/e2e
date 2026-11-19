/** A node scrolled into view paints where its box says, so a screenshot cut to the box holds the node and nothing else, and it leaves every scroller that clipped it, through shadow roots and slots. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '@e2e-dev/core/lib/internal/image';
import { byRole, startWebSession, type WebSession } from '../helpers/web-session.ts';

const GREEN = '<div id="far" style="margin-top:1600px;width:64px;height:24px;background:#16a34a"></div>';

describe('scrolling into view', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession();
  });
  afterAll(async () => {
    await page?.close();
  });

  /** The first screenshot row the green block paints and how many it paints, beside the row its box rounds to and its height. */
  async function rows(): Promise<{ painted: [number, number]; box: [number, number] }> {
    await page.browser.locator('#far').scrollIntoView();
    const box = (await page.browser.locator('#far').boundingBox())!;
    const shot = decodePng((await page.observe({ pixels: true })).pixels!.data);
    const green = Array.from({ length: shot.height }, (_, y) => y).filter((y) => shot.data[(y * shot.width + box.x + 2) * 4 + 1] === 163);
    return { painted: [green[0]!, green.length], box: [Math.round(box.y), 24] };
  }

  it('lands on a whole pixel when the node sits at a fractional offset, at the end of the page too', async () => {
    for (const after of ['', '<div style="height:2000px"></div>']) {
      await page.setContent(`<h1>Swatches</h1><div style="display:flex;padding:8px"><div style="width:40px;height:40px"></div></div><iframe style="height:80px;border:0"></iframe>${GREEN}${after}`);
      const { painted, box } = await rows();
      expect(painted).toEqual(box);
    }
  });

  it.each(['open', 'closed'] as const)('scrolls a node out from under a scroller across %s shadow roots: one around its root\'s host, and one around its slot', async (mode) => {
    /** Whether the scroller shows the whole target. */
    const shown = (): Promise<boolean> => page.browser.evaluate<boolean>(`(() => {
      const [inner, outer] = [window.target.getBoundingClientRect(), window.scroller.getBoundingClientRect()];
      return inner.top >= outer.top && inner.bottom <= outer.bottom;
    })()`);
    const scroller = 'style="height:100px;overflow:auto"';
    const pages = [
      `<div id=outer ${scroller}><div style="height:300px"></div><div id=host></div></div>
      <script>
        const root = host.attachShadow({ mode: '${mode}' });
        root.innerHTML = '<button id=target>Target</button>';
        Object.assign(window, { scroller: outer, target: root.getElementById('target') });
      </script>`,
      `<div id=host><div style="height:300px"></div><button id=target>Target</button></div>
      <script>
        const root = host.attachShadow({ mode: '${mode}' });
        root.innerHTML = '<div id=around ${scroller}><slot></slot></div>';
        Object.assign(window, { scroller: root.getElementById('around'), target: document.getElementById('target') });
      </script>`,
    ];
    for (const html of pages) {
      await page.setContent(html);
      expect(await shown()).toBe(false);
      await page.act(byRole('button', 'Target'), { kind: 'scrollIntoView' });
      expect(await shown()).toBe(true);
    }
  });
});
