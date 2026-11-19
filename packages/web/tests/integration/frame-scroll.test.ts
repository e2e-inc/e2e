/**
 * `scrollIntoView` on a node inside a frame ends with the node inside the
 * top-level viewport, whatever the frame's size: a frame taller than the
 * viewport, or than the scroller it sits in, is scrolled for the node's own
 * box, through every frame holding it. A frame that fits the viewport is
 * centred as a whole.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attribute, withinFrames } from '../helpers/frames.ts';
import { byRole, startWebSession, type WebSession } from '../helpers/web-session.ts';

const PAY = byRole('button', 'Pay');

/** A frame document with one button `top` pixels down it. */
const framed = (top: number): string => `<style>body { margin: 0 }</style><button style="position:absolute;top:${String(top)}px;left:20px;width:80px;height:24px">Pay</button>`;

/** A page that scrolls past both ends of `content`, opened scrolled to its end. */
const scrolledPast = (content: string): string => `<!doctype html><style>body { margin: 0 } iframe { display: block; border: 0; width: 400px }</style>
  <div style="height:1500px"></div>${content}<div style="height:1500px"></div>
  <script>addEventListener('load', () => scrollTo(0, document.documentElement.scrollHeight));</script>`;

describe('scrollIntoView through frames', () => {
  let page: WebSession;

  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000 });
  });

  afterAll(async () => {
    await page.close();
  });

  /** Opens `html`, waits for its frames, and scrolls the button inside `frames` into view. */
  async function scrollToPay(html: string, frames: readonly string[]): Promise<void> {
    await page.setContent(html);
    await page.waitForFrames();
    await page.act(withinFrames(frames, PAY), { kind: 'scrollIntoView' });
  }

  /**
   * How far the button's box reaches past each side of the top-level
   * viewport, measured through the same-origin documents of `frames`: all
   * zero for a box inside it.
   */
  const overflowOf = (frames: readonly string[]) => page.browser.evaluate((selectors) => {
    let x = 0;
    let y = 0;
    let doc = document;
    for (const selector of selectors) {
      const frame = doc.querySelector<HTMLIFrameElement>(selector)!;
      const style = getComputedStyle(frame);
      const box = frame.getBoundingClientRect();
      x += box.x + frame.clientLeft + Number.parseFloat(style.paddingLeft);
      y += box.y + frame.clientTop + Number.parseFloat(style.paddingTop);
      doc = frame.contentDocument!;
    }
    const button = doc.querySelector('button')!.getBoundingClientRect();
    /** How far `distance` reaches past a side; none for one short of it. */
    const past = (distance: number): number => Math.max(0, distance);
    return { left: past(-(x + button.left)), top: past(-(y + button.top)), right: past(x + button.right - innerWidth), bottom: past(y + button.bottom - innerHeight) };
  }, frames);

  const INSIDE = { left: 0, top: 0, right: 0, bottom: 0 };

  it.each([
    ['at its top', 0],
    ['a third of the way down', 1000],
    ['at its bottom', 2976],
  ])('brings a button %s of a frame taller than the viewport into the viewport', async (_name, top) => {
    await scrollToPay(scrolledPast(`<iframe style="height:3000px" srcdoc="${attribute(framed(top))}"></iframe>`), ['iframe']);
    expect(await overflowOf(['iframe'])).toEqual(INSIDE);
  });

  it('brings a button of a tall frame into the viewport when the frame\'s centre already shows', async () => {
    const html = `<!doctype html><style>body { margin: 0 } iframe { display: block; border: 0; width: 400px }</style>
      <iframe style="height:3000px" srcdoc="${attribute(framed(2976))}"></iframe>
      <script>addEventListener('load', () => scrollTo(0, 1200));</script>`;
    await scrollToPay(html, ['iframe']);
    expect(await overflowOf(['iframe'])).toEqual(INSIDE);
  });

  it('brings a button of a frame nested in a tall frame into the viewport', async () => {
    const outer = `<style>body { margin: 0 } iframe { display: block; border: 0; width: 300px; height: 200px; margin-top: 2600px }</style><iframe id="inner" srcdoc="${attribute(framed(100))}"></iframe>`;
    await scrollToPay(scrolledPast(`<iframe id="outer" style="height:3000px" srcdoc="${attribute(outer)}"></iframe>`), ['#outer', '#inner']);
    expect(await overflowOf(['#outer', '#inner'])).toEqual(INSIDE);
  });

  it('brings a button of a tall frame nested in a tall frame into the viewport', async () => {
    const outer = `<style>body { margin: 0 } iframe { display: block; border: 0; width: 300px; height: 2500px; margin-top: 400px }</style><iframe id="inner" srcdoc="${attribute(framed(2000))}"></iframe>`;
    await scrollToPay(scrolledPast(`<iframe id="outer" style="height:3000px" srcdoc="${attribute(outer)}"></iframe>`), ['#outer', '#inner']);
    expect(await overflowOf(['#outer', '#inner'])).toEqual(INSIDE);
  });

  it('brings a button of a frame taller than the scroller around it into the scroller\'s view', async () => {
    const html = `<!doctype html><style>body { margin: 0 } iframe { display: block; border: 0; width: 400px }</style>
      <div id="scroller" style="margin-top:100px;height:300px;overflow:auto"><iframe style="height:3000px" srcdoc="${attribute(framed(1000))}"></iframe></div>`;
    await scrollToPay(html, ['iframe']);
    expect(await overflowOf(['iframe'])).toEqual(INSIDE);
    expect(await page.browser.evaluate(() => {
      const scroller = document.querySelector('#scroller')!.getBoundingClientRect();
      const frame = document.querySelector('iframe')!;
      const button = frame.contentDocument!.querySelector('button')!.getBoundingClientRect();
      const top = frame.getBoundingClientRect().top + button.top;
      return top >= scroller.top && top + button.height <= scroller.bottom;
    })).toBe(true);
  });

  it('brings a button of a tall frame from another origin into the viewport', async () => {
    const inner = page.serve('/tall-frame-document', framed(1000)).replace('127.0.0.1', 'localhost');
    await scrollToPay(scrolledPast(`<iframe style="height:3000px" src="${inner}"></iframe>`), ['iframe']);
    const [node] = await page.locate(withinFrames(['iframe'], PAY));
    const viewport = await page.browser.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(node!.rect).toMatchObject({ width: 80, height: 24 });
    expect(node!.rect!.y).toBeGreaterThanOrEqual(0);
    expect(node!.rect!.y + node!.rect!.height).toBeLessThanOrEqual(viewport.height);
    expect(node!.rect!.x).toBeGreaterThanOrEqual(0);
    expect(node!.rect!.x + node!.rect!.width).toBeLessThanOrEqual(viewport.width);
  });

  it('centres a frame that fits the viewport, with its button in view', async () => {
    await scrollToPay(scrolledPast(`<iframe style="height:200px" srcdoc="${attribute(framed(150))}"></iframe>`), ['iframe']);
    expect(await overflowOf(['iframe'])).toEqual(INSIDE);
    expect(await page.browser.evaluate(() => {
      const frame = document.querySelector('iframe')!.getBoundingClientRect();
      return frame.top - (innerHeight - frame.height) / 2;
    })).toBe(0);
  });
});
