/** Touch emulation: with `web({ hasTouch: true })` a tap touches the screen and a swipe along a path drags a finger, in a real Chromium. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { OperationContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const PAGE = `<button style="width:200px;height:100px">Go</button><script>
  window.events = [];
  for (const type of ['touchstart', 'touchmove', 'touchend', 'click']) document.addEventListener(type, (event) => window.events.push(type));
</script>`;

const signal = new AbortController().signal;
const operation = (): OperationContext => ({ signal, timeoutMs: 10_000, runId: 'touch', attemptId: 'a', origin: 'test' });
const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-touch-'));

afterAll(() => rmSync(projectRoot, { recursive: true, force: true }));

/** Runs `act` on a fresh page of a surface built with `hasTouch`, and returns the event types the page saw. */
async function eventsOf(hasTouch: boolean, act: (surface: PlaywrightSurface) => Promise<void>): Promise<string[]> {
  const surface = new PlaywrightSurface({ hasTouch });
  try {
    await surface.init({ runId: 'touch', targetName: 'web', projectRoot, app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.startAttempt({ attemptId: 'a', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    const page = await surface.ensurePage();
    await page.setContent(PAGE);
    await act(surface);
    return await page.evaluate(() => (window as unknown as { events: string[] }).events);
  } finally {
    await surface.endAttempt({ signal, timeoutMs: 10_000 });
    await surface.dispose({ signal, timeoutMs: 10_000 });
  }
}

/** Taps the page's button through the node an observation lists. */
async function tapButton(surface: PlaywrightSurface): Promise<void> {
  const button = (await surface.observe(operation())).root.children?.find((node) => node.role === 'button');
  if (button === undefined) throw new Error('the observation lists no button');
  await surface.perform(button.ref, { kind: 'tap' }, operation());
}

describe('web({ hasTouch })', () => {
  it('taps a node with touch events, which the browser follows with a click', async () => {
    expect(await eventsOf(true, tapButton)).toEqual(['touchstart', 'touchend', 'click']);
  });

  it('taps a point with touch events', async () => {
    const events = await eventsOf(true, async (surface) => {
      await surface.observe(operation());
      await surface.performAt({ x: 50, y: 50 }, { kind: 'tap' }, operation());
    });
    expect(events).toEqual(['touchstart', 'touchend', 'click']);
  });

  it('swipes along a path with touch moves on chromium', async () => {
    const events = await eventsOf(true, async (surface) => {
      await surface.observe(operation());
      await surface.performAt({ x: 20, y: 50 }, { kind: 'swipeTo', target: { x: 180, y: 50 } }, operation());
    });
    expect(events).toEqual(['touchstart', 'touchmove', 'touchmove', 'touchend']);
  });

  it('clicks without touch events by default', async () => {
    expect(await eventsOf(false, tapButton)).toEqual(['click']);
  });
});
