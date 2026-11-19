/**
 * Which ancestors clip a node. The viewport takes the root's `overflow` and,
 * by CSS Overflow 3's viewport propagation, the `<body>`'s, so neither clips
 * to its own box; a `display: contents` element has no box to clip to, and
 * none a positioned node could be laid out against. A top-layer element (a
 * modal dialog, an open popover, a fullscreen element) is laid out against
 * the viewport, so nothing around it clips what it holds. Everything else
 * with an `overflow` other than `visible` clips what is laid out in it, and
 * so does a box with paint containment (`contain`, `content-visibility`)
 * whatever its `overflow`: each at its padding edge, or where its
 * `overflow-clip-margin` puts the edge of an `overflow: clip` or a paint
 * containment.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => {
  page = await startWebSession({ timeoutMs: 10_000 });
});

afterAll(async () => {
  await page.close();
});

const BUTTON = '<button onclick="document.title = \'clicked\'" style="width:80px;height:24px">Target</button>';

/** A button past the end of the first screen, with room after it to centre it. */
const BELOW = `<div style="height:2000px"></div>${BUTTON}<div style="height:600px"></div>`;

/** A button drawn above its parent's box, where no scroll of the parent brings it. */
const ABOVE = BUTTON.replace('style="', 'style="position:relative;top:-80px;');

/** The button with `css` before its size. */
const styled = (css: string): string => BUTTON.replace('style="', `style="${css};`);

/** How far the button's top is from where a centred button's would be. */
const offCentre = (): Promise<number> => page.browser.evaluate(() => document.querySelector('button')!.getBoundingClientRect().top - (innerHeight - 24) / 2);

const title = (): Promise<string> => page.browser.evaluate(() => document.title);

/**
 * Whether the browser's own hit test reaches the button where it draws: at
 * the centre of its box, or of its contents' box for a `display: contents`
 * button, which has none of its own. False for one its ancestors clip away.
 */
const painted = (): Promise<boolean> => page.browser.evaluate(() => {
  const button = document.querySelector('button')!;
  const contents = document.createRange();
  contents.selectNodeContents(button);
  const { left, top, width, height } = (button.getClientRects().length > 0 ? button : contents).getBoundingClientRect();
  return document.elementFromPoint(left + width / 2, top + height / 2) === button;
});

/** Taps the button, expecting the tap to end its budget on `reason` with nothing clicked. */
async function expectRefused(reason: string): Promise<void> {
  const [button] = await page.locate(bySelector('button'));
  await expect(page.engine.perform!(button!.ref, { kind: 'tap' }, page.op(2_000))).rejects.toMatchObject({
    code: 'NOT_ACTIONABLE',
    message: expect.stringContaining(reason),
  });
  expect(await title()).toBe('');
}

/** Taps the button, expecting the tap to find it clipped away until its budget ends. */
const expectClipped = (): Promise<void> => expectRefused('element is outside of the viewport');

/** The values that turn paint containment on. */
const PAINT_CONTAINMENTS = ['contain:paint', 'contain:strict', 'contain:content', 'content-visibility:auto'];

describe('clip containers', () => {
  it.each([
    ['overflow-x: hidden on a full-height body', 'html, body { height: 100%; margin: 0 } body { overflow-x: hidden }'],
    ['overflow: hidden on the root alone', 'html { overflow: hidden }'],
    ['a body that scrolls for a root with overflow: hidden', 'html { overflow: hidden } html, body { height: 100%; margin: 0 } body { overflow: auto }'],
  ])('scrolls to a target below the fold and taps it: %s', async (_name, css) => {
    await page.setContent(`<!doctype html><style>${css}</style>${BELOW}`);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    ['overflow-x: hidden', 'overflow-x: hidden'],
    ['overflow: hidden', 'overflow: hidden'],
    ['overflow: clip', 'overflow: clip'],
  ])('taps a target outside the box of a body whose overflow the viewport takes: %s', async (_name, body) => {
    await page.setContent(`<!doctype html><style>body { margin: 100px 0 0; ${body} }</style>${ABOVE}`);
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    ['the root has overflow: hidden too', 'overflow: hidden', 'overflow: hidden'],
    ['the root has overflow-x: hidden, so is not visible on both axes', 'overflow-x: hidden', 'overflow: hidden'],
    ['the root has overflow: clip', 'overflow: clip', 'overflow: hidden'],
    ['the root has containment', 'contain: layout', 'overflow: hidden'],
    ['the root is a size container', 'container-type: inline-size', 'overflow: hidden'],
    ['the body has containment', '', 'overflow: hidden; contain: style'],
    ['the body has content-visibility: auto', '', 'overflow: hidden; content-visibility: auto'],
    ['the body is a size container', '', 'overflow: hidden; container-type: inline-size'],
  ])('refuses a tap on a target clipped by a body that keeps its own overflow: %s', async (_name, root, body) => {
    await page.setContent(`<!doctype html><style>html { ${root} } body { margin: 100px 0 0; ${body} }</style>${ABOVE}`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('refuses a tap on a target clipped by a second body, which keeps its own overflow though the first is display: none', async () => {
    await page.setContent(`<!doctype html><style>body { margin: 100px 0 0 }</style><script>
      const first = document.documentElement.appendChild(document.createElement('body'));
      first.style.display = 'none';
      const second = document.documentElement.appendChild(document.createElement('body'));
      second.style.overflow = 'hidden';
      second.innerHTML = ${JSON.stringify(ABOVE)};
    </script>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('refuses a tap on a target an ordinary overflow: hidden box clips away', async () => {
    await page.setContent(`<div style="margin-top:100px;overflow:hidden">${ABOVE}</div>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('taps a target under a display: contents element with overflow: hidden, which lays out no box to clip to', async () => {
    await page.setContent(`<div style="display:contents;overflow:hidden">${BUTTON}</div>`);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    ['a modal dialog under a transformed ancestor', `<div style="transform:translateX(0);overflow:hidden;height:40px"><dialog>${BUTTON}</dialog></div>`, 'document.querySelector("dialog").showModal()'],
    ['an open popover under a positioned ancestor', `<div style="position:relative;overflow:hidden;height:40px"><div popover style="position:absolute;inset:auto;top:80px">${BUTTON}</div></div>`, 'document.querySelector("[popover]").showPopover()'],
    [
      'an open popover inside a modal dialog that clips its own content',
      `<dialog style="overflow:hidden;height:40px"><div popover style="position:absolute;inset:auto;top:10px;left:10px">${BUTTON}</div></dialog>`,
      'document.querySelector("dialog").showModal(); document.querySelector("[popover]").showPopover()',
    ],
  ])('taps a target in a top-layer element past an overflow: hidden ancestor, which does not clip it: %s', async (_name, html, open) => {
    await page.setContent(`<!doctype html>${html}<script>${open}</script>`);
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    ['a modal dialog', `<dialog style="overflow:hidden">${ABOVE}</dialog>`, 'document.querySelector("dialog").showModal()'],
    ['an open popover', `<div popover style="overflow:hidden">${ABOVE}</div>`, 'document.querySelector("[popover]").showPopover()'],
  ])('refuses a tap on a target a top-layer element clips by its own overflow: %s', async (_name, html, open) => {
    await page.setContent(`<!doctype html>${html}<script>${open}</script>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it.each([
    ['position: relative, under an absolute target', 'position:relative', 'position:absolute;top:100px'],
    ['a transform, under a fixed target', 'transform:translateX(0)', 'position:fixed;top:100px'],
  ])('taps a target past an overflow: hidden box that a display: contents ancestor does not lay it out against: %s', async (_name, contents, target) => {
    await page.setContent(`<!doctype html><div style="overflow:hidden;height:20px"><div style="display:contents;${contents}">${styled(target)}</div></div>`);
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    'translate:0px',
    'rotate:0deg',
    'scale:1',
    'contain:strict',
    'contain:content',
    'content-visibility:auto',
    'will-change:transform',
    'backdrop-filter:blur(1px)',
  ])('refuses a tap on a fixed target clipped by an overflow: hidden ancestor that %s makes its containing block', async (css) => {
    await page.setContent(`<!doctype html><div style="margin-top:100px;overflow:hidden;width:200px;height:20px;${css}">${styled('position:fixed;top:-80px')}</div>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it.each([
    'display:inline;contain:layout',
    'display:inline;contain:paint',
    'display:inline;content-visibility:auto',
    'display:table-row;contain:strict',
  ])('taps a fixed target past an overflow: hidden box when the box between them takes no containment: %s', async (css) => {
    await page.setContent(`<!doctype html><div style="overflow:hidden;height:20px"><div style="${css}">${styled('position:fixed;top:100px')}</div></div>`);
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each(PAINT_CONTAINMENTS)('taps the part of a target that shows in a box with %s and no overflow of its own', async (css) => {
    await page.setContent(`<!doctype html><div style="${css};height:10px">${BUTTON}</div>`);
    expect(await painted()).toBe(false);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each(PAINT_CONTAINMENTS)('refuses a tap on a target a box with %s clips away, whatever its overflow', async (css) => {
    await page.setContent(`<!doctype html><div style="margin-top:100px;${css}">${ABOVE}</div>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it.each([
    ['an inline box', 'display:inline'],
    ['a table row', 'display:table-row'],
  ])('taps a target outside %s with contain: paint, which takes no containment', async (_name, display) => {
    await page.setContent(`<!doctype html><div style="margin-top:100px"><div style="${display};contain:paint">${ABOVE}</div></div>`);
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it('refuses a tap on a target outside the box of a root with paint containment, whose overflow the viewport still takes', async () => {
    await page.setContent(`<!doctype html><style>html { contain: paint; height: 100px }</style><div style="height:300px"></div>${BUTTON}`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it.each(['contain:paint', 'overflow:hidden', 'overflow:clip'])('taps the part of a target inside the padding edge of a box with %s, past its border', async (css) => {
    await page.setContent(`<!doctype html><div style="${css};height:40px;border:30px solid silver">${styled('position:relative;top:-18px')}</div>`);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each(['contain:paint', 'overflow:hidden', 'overflow:clip'])('refuses a tap on a target wholly under the border of a box with %s', async (css) => {
    await page.setContent(`<!doctype html><div style="${css};height:40px;border:30px solid silver">${styled('position:relative;top:-30px')}</div>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it.each(['contain:paint', 'overflow:clip'])('taps a target outside a box with %s, inside its overflow-clip-margin', async (css) => {
    await page.setContent(`<!doctype html><div style="margin-top:100px;${css};overflow-clip-margin:30px">${styled('position:relative;top:-28px')}</div>`);
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    ['past the overflow-clip-margin of a box with contain: paint', 'contain:paint;overflow-clip-margin:30px', 'top:-80px'],
    ['inside the overflow-clip-margin of a box with overflow: hidden, which has no use for one', 'overflow:hidden;overflow-clip-margin:30px', 'top:-28px'],
    ['in the padding of a box with contain: paint whose overflow-clip-margin names its content box', 'contain:paint;overflow-clip-margin:content-box;padding-top:40px', 'top:-32px'],
  ])('refuses a tap on a target %s', async (_name, css, target) => {
    await page.setContent(`<!doctype html><div style="margin-top:100px;${css}">${styled(`position:relative;${target}`)}</div>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('scrolls to and taps a target past the placeholder size of a content-visibility: auto box below the fold', async () => {
    await page.setContent(`<!doctype html><div style="height:2000px"></div><div style="content-visibility:auto;contain-intrinsic-size:auto 50px"><div style="height:400px"></div>${BUTTON}</div><div style="height:600px"></div>`);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it('refuses a tap on a target a content-visibility: hidden ancestor skips, as not visible, and reads it hidden', async () => {
    await page.setContent(`<!doctype html><div style="content-visibility:hidden;height:40px">${BUTTON}</div>`);
    expect(await painted()).toBe(false);
    expect((await page.locate(bySelector('button')))[0]?.states?.hidden).toBe(true);
    await expectRefused('element is not visible');
  });

  it('refuses a tap on a target clipped by the positioned box around a display: contents element', async () => {
    await page.setContent(`<!doctype html><div style="margin-top:100px;position:relative;overflow:hidden;height:20px"><div style="display:contents">${styled('position:absolute;top:-80px')}</div></div>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('refuses a tap on a display: contents target with a position of its own, clipped by the box its text is laid out in', async () => {
    /** The page with the style `box` on the outer box, which the button's text is laid out in and reaches past. */
    const laidOutIn = (box: string): string => `<!doctype html><div style="margin-top:100px;${box};height:20px"><div style="margin-top:-80px;height:24px">${styled('display:contents;position:absolute')}</div></div>`;
    await page.setContent(laidOutIn('overflow:visible'));
    expect(await painted()).toBe(true);
    await page.setContent(laidOutIn('overflow:hidden'));
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('centres a node it scrolls into view, with and without an overflow on the body that the viewport takes', async () => {
    const tops: number[] = [];
    for (const css of ['', 'html, body { height: 100%; margin: 0 } body { overflow-x: hidden }']) {
      await page.setContent(`<!doctype html><style>body { margin: 0 } ${css}</style>${BELOW}`);
      await page.act(bySelector('button'), { kind: 'scrollIntoView' });
      tops.push(await offCentre());
    }
    expect(tops).toEqual([0, 0]);
  });

  it.each([
    ['in an open popover', `<div popover style="position:absolute;inset:auto;top:2000px;margin:0;padding:0;border:0">${BUTTON}</div>`, 'document.querySelector("[popover]").showPopover()'],
    ['absolute, under a display: contents element with position: relative', `<div style="display:contents;position:relative">${styled('position:absolute;top:2000px')}</div>`, ''],
    ['absolute, with no positioned ancestor', styled('position:absolute;top:2000px'), ''],
  ])('centres a node it scrolls into view past an overflow: hidden ancestor that does not clip it: %s', async (_name, html, open) => {
    await page.setContent(`<!doctype html><style>body { margin: 0 }</style><div style="overflow:hidden;height:40px">${html}</div><div style="height:4000px"></div><script>${open}</script>`);
    await page.act(bySelector('button'), { kind: 'scrollIntoView' });
    expect(await offCentre()).toBe(0);
  });

  it('scrolls a node to the nearest edge of the positioned overflow: hidden box that clips it', async () => {
    await page.setContent(`<!doctype html><style>body { margin: 0 }</style><div style="position:relative;overflow:hidden;height:100px">${styled('position:absolute;top:300px')}</div>`);
    await page.act(bySelector('button'), { kind: 'scrollIntoView' });
    expect(await page.browser.evaluate(() => document.querySelector('button')!.getBoundingClientRect().bottom)).toBe(100);
  });

  it('taps a target in a fullscreen element past an overflow: hidden ancestor, which does not clip it', async () => {
    await page.setContent(`<!doctype html><div style="transform:translateX(0);overflow:hidden;height:40px">
      <span id="enter" onclick="document.getElementById('stage').requestFullscreen()">Enter</span>
      <div id="stage" style="background:white">${styled('position:relative;top:200px')}</div>
    </div>
    <script>window.entered = new Promise((resolve) => document.addEventListener('fullscreenchange', resolve, { once: true }));</script>`);
    await page.act(bySelector('#enter'), { kind: 'tap' });
    await page.browser.evaluate('window.entered.then(() => null)');
    expect(await page.browser.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('stage');
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
    await page.browser.evaluate(() => document.exitFullscreen().then(() => null));
  });
});
