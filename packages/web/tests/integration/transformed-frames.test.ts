/**
 * A tap inside a frame a 3D transform turns lands on its target: the point
 * is carried through the quad the browser lays each turned frame out on,
 * nested turned frames composing, and inside a cross-origin frame. A frame
 * no point maps through yet is waited for.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from '@e2e-dev/core/engine';
import { attribute, withinFrames } from '../helpers/frames.ts';
import { byRole, startWebSession, type WebSession } from '../helpers/web-session.ts';

const TURN = 'transform: translate(60px, 40px) scale(1.2) rotate3d(1, 1, 1, 25deg)';
const FRAME_STYLE = `border: 4px solid black; padding: 3px; margin: 20px; width: 260px; height: 200px; ${TURN}`;
const TARGET = `<style>body { margin: 0 } button { margin: 30px 0 0 40px; width: 6px; height: 6px; padding: 0; border: 0 }</style><button aria-label="Target" onclick="this.setAttribute('aria-label', 'Clicked')"></button>`;

/** The target button, by its name. */
function button(name: string, frames: readonly string[]): LocatorExpression {
  return withinFrames(frames, byRole('button', name));
}

describe('taps in turned frames', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000 });
  });
  afterAll(async () => {
    await page.close();
  });

  /** Taps the target through `frames` and checks the click reached it. */
  async function tapThrough(frames: readonly string[]): Promise<void> {
    await page.waitForFrames();
    await page.act(button('Target', frames), { kind: 'tap' });
    expect(await page.locate(button('Clicked', frames))).toHaveLength(1);
  }

  it('taps through one frame rotated in 3D', async () => {
    await page.setContent(`<iframe id="outer" style="${FRAME_STYLE}" srcdoc="${attribute(TARGET)}"></iframe>`);
    await tapThrough(['#outer']);
  });

  it('taps through two nested turned frames', async () => {
    const inner = `<style>body { margin: 0 }</style><iframe id="inner" style="${FRAME_STYLE}" srcdoc="${attribute(TARGET)}"></iframe>`;
    await page.setContent(`<iframe id="outer" style="${FRAME_STYLE}; width: 400px; height: 360px" srcdoc="${attribute(inner)}"></iframe>`);
    await tapThrough(['#outer', '#inner']);
  });

  it('waits for a frame scaled to nothing to grow, as it waits for the element in it', async () => {
    await page.setContent(`<iframe id="outer" style="${FRAME_STYLE}; transform: scale(0)" srcdoc="${attribute(TARGET)}"></iframe>`);
    await page.waitForFrames();
    const [target] = await page.locate({ kind: 'frame', selector: '#outer', source: { kind: 'selector', selector: 'button' } });
    await expect(page.engine.perform!(target!.ref, { kind: 'tap' }, page.op(1_500))).rejects.toMatchObject({
      code: 'NOT_ACTIONABLE',
      message: 'element did not become actionable in time: element is in a frame that lays out no box, or whose transform the browser maps no point through',
    });
    await page.browser.evaluate(() => {
      setTimeout(() => { document.getElementById('outer')!.style.transform = 'none'; }, 300);
      return null;
    });
    await page.engine.perform!(target!.ref, { kind: 'tap' }, page.op());
    expect(await page.locate(button('Clicked', ['#outer']))).toHaveLength(1);
  });

  it('taps through a turned frame inside a cross-origin frame', async () => {
    const target = page.serve('/turned-target', TARGET);
    const middle = page.serve('/turned-middle', `<style>body { margin: 0 }</style><iframe id="inner" style="${FRAME_STYLE}" src="${target}"></iframe>`);
    const crossOrigin = middle.replace('127.0.0.1', 'localhost');
    await page.setContent(`<iframe id="outer" style="border: 2px solid; margin: 15px 0 0 25px; width: 420px; height: 380px" src="${crossOrigin}"></iframe>`);
    await tapThrough(['#outer', '#inner']);
  });
});
