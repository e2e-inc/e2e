/**
 * Steps of more than one user in one attempt: `StepRecorder.forUser` is a
 * peer's view of the attempt's one recorder. Every step it opens is the
 * peer's, and what the peer's app reports, the screens it shows, and the
 * checks that pass on it stay with that peer's steps.
 */

import { describe, expect, it } from 'vitest';
import type { AppEvent } from '../../src/engine/surface.ts';
import { APP_LOG_LIMITS } from '../../src/engine/session.ts';
import { StepRecorder, type StepHoldRequest, type StepProgress } from '../../src/run/steps.ts';

/** The agent and target peer ava's steps are attributed to. */
const AVA = { agent: 'default', target: 'web' };

const pass = async (): Promise<void> => undefined;
const log = (text: string): AppEvent => ({ kind: 'log', entry: { source: 'console', level: 'warning', text } });
/** A screen of one line, as `recordScreen` reads it. */
const screen = (text: string) => () => ({ location: 'http://app.test/', lines: [{ id: 'root', text }] });

describe('StepRecorder.forUser', () => {
  it("marks each step a peer opens, and the steps inside it, as the peer's, and the test's own as no one's", async () => {
    const heard: StepProgress[] = [];
    const steps = new StepRecorder('attempt', { onProgress: (progress) => heard.push(progress) });
    const ava = steps.forUser('ava', AVA);
    await steps.run('app', 'app.open', '/', pass);
    await ava.run('agent', 'agent.act', 'accept the invite', async () => {
      await ava.run('locator', 'locator.tap', 'button "Accept"', async () => {
        steps.activity('action');
        steps.recordEvent({ kind: 'engine', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, status: 'passed', detail: 'tapped' });
      });
    });
    expect(steps.all().map((step) => [step.api, step.user])).toEqual([
      ['app.open', undefined],
      ['agent.act', 'ava'],
      ['locator.tap', 'ava'],
    ]);
    expect(Object.hasOwn(steps.all()[0]!, 'user')).toBe(false);
    // Every phase a reporter hears names the peer whose step it is.
    expect(heard.map((progress) => [progress.phase, progress.identity?.user])).toEqual([
      ['start', undefined],
      ['end', undefined],
      ['start', 'ava'],
      ['start', 'ava'],
      ['activity', 'ava'],
      ['event', 'ava'],
      ['end', 'ava'],
      ['end', 'ava'],
    ]);
    expect(Object.hasOwn(heard[0]!.identity!, 'user')).toBe(false);
  });

  it("lists only the peer's own finished steps", async () => {
    const steps = new StepRecorder('attempt');
    const ava = steps.forUser('ava', AVA);
    await steps.run('app', 'app.open', '/', pass);
    await ava.run('app', 'app.open', '/invites', pass);
    expect(ava.completed().map((step) => step.label)).toEqual(['/invites']);
    expect(steps.completed()).toHaveLength(2);
  });

  it("records the test's own step inside a peer's step as the test's own: every step of a peer names it", async () => {
    const steps = new StepRecorder('attempt');
    const ava = steps.forUser('ava', AVA);
    // The test's own check in an `onAction` hook of Ava's agent step, beside one of Ava's own.
    await ava.run('agent', 'agent.act', 'accept the invite', async () => {
      await steps.run('assertion', 'expect.toBeVisible', 'getByText("Cart")', pass);
      await ava.run('locator', 'locator.tap', 'button "Accept"', pass);
    });
    expect(steps.all().map((step) => [step.api, step.user])).toEqual([
      ['agent.act', 'ava'],
      ['expect.toBeVisible', undefined],
      ['locator.tap', 'ava'],
    ]);
    expect(ava.completed().map((step) => step.api)).toEqual(['agent.act', 'locator.tap']);
  });

  it("files what a peer's app reports between steps with that peer's last step, and its first navigation with its first step", async () => {
    const steps = new StepRecorder('attempt');
    const ava = steps.forUser('ava', AVA);
    steps.recordAppEvent({ kind: 'navigation', line: 'ava went to /invites' }, '2026-01-01T00:00:00.000Z', 'ava');
    await ava.run('app', 'app.open', '/invites', pass);
    await steps.run('app', 'app.open', '/', pass);
    // Both arrive after the test's own step, the newest; each lands with its own user's last step.
    steps.recordAppEvent(log('invite link expires soon'), '2026-01-01T00:00:01.000Z', 'ava');
    steps.recordAppEvent(log('cart is empty'), '2026-01-01T00:00:02.000Z');
    expect(steps.all()[0]!.events.map((event) => event.detail)).toEqual(['ava went to /invites']);
    expect(steps.all()[1]!.events).toEqual([]);
    expect(steps.appLog().map((line) => [line.text, line.step, line.user])).toEqual([
      ['invite link expires soon', 0, 'ava'],
      ['cart is empty', 1, undefined],
    ]);
    expect(Object.hasOwn(steps.appLog()[1]!, 'user')).toBe(false);
  });

  it("keeps each user's app log within its own limit, so a noisy peer leaves the test's own errors in", async () => {
    const steps = new StepRecorder('attempt');
    const ava = steps.forUser('ava', AVA);
    await ava.run('app', 'app.open', '/invites', pass);
    await steps.run('app', 'app.open', '/', pass);
    for (let index = 0; index <= APP_LOG_LIMITS.errorsAndWarnings; index += 1) steps.recordAppEvent(log(`ava noise ${index}`), '2026-01-01T00:00:01.000Z', 'ava');
    steps.recordAppEvent(log('checkout failed'), '2026-01-01T00:00:02.000Z');
    const lines = steps.appLog();
    expect(lines.filter((line) => line.user === 'ava')).toHaveLength(APP_LOG_LIMITS.errorsAndWarnings);
    expect(lines.filter((line) => line.user === undefined).map((line) => line.text)).toEqual(['checkout failed']);
  });

  it("files what a peer's app reports while the test's own step runs with the peer's last step, not the running one", async () => {
    const steps = new StepRecorder('attempt');
    await steps.forUser('ava', AVA).run('app', 'app.open', '/invites', pass);
    await steps.run('app', 'app.open', '/', async () => {
      steps.recordAppEvent(log('invite link expires soon'), '2026-01-01T00:00:01.000Z', 'ava');
      steps.recordAppEvent({ kind: 'navigation', line: 'ava went to /invites/1' }, '2026-01-01T00:00:01.000Z', 'ava');
      steps.recordAppEvent(log('cart is empty'), '2026-01-01T00:00:02.000Z');
    });
    expect(steps.appLog().map((line) => [line.text, line.step])).toEqual([
      ['invite link expires soon', 0],
      ['cart is empty', 1],
    ]);
    expect(steps.all().map((step) => step.events.map((event) => event.detail))).toEqual([['ava went to /invites/1'], []]);
  });

  it("compares each step's screen with the last one its own user saw", async () => {
    const steps = new StepRecorder('attempt');
    const ava = steps.forUser('ava', AVA);
    await steps.run('app', 'app.open', '/', async () => steps.recordScreen(screen('document "Cart"')));
    await ava.run('app', 'app.open', '/invites', async () => steps.recordScreen(screen('document "Invites"')));
    await steps.run('app', 'app.reload', '/', async () => steps.recordScreen(screen('document "Cart"')));
    await ava.run('app', 'app.reload', '/invites', async () => steps.recordScreen(screen('document "Invites"')));
    expect(steps.all().map((step) => [step.screen?.since, step.screen?.changes])).toEqual([
      [undefined, []],
      [undefined, []],
      [0, []],
      [1, []],
    ]);
  });

  it("confirms by a passed check only that check's own user's steps", async () => {
    const steps = new StepRecorder('attempt');
    const ava = steps.forUser('ava', AVA);
    await ava.run('agent', 'agent.act', 'accept the invite', pass);
    await steps.run('agent', 'agent.act', 'send the invite', pass);
    await steps.run('assertion', 'expect.toBeVisible', 'sent', pass, { verifies: true });
    expect(steps.lastVerifiedStepIndex).toBe(2);
    expect(steps.lastVerifiedStepIndexOf(undefined)).toBe(2);
    expect(steps.lastVerifiedStepIndexOf('ava')).toBe(-1);
    await ava.run('assertion', 'expect.toBeVisible', 'joined', pass, { verifies: true });
    expect(steps.lastVerifiedStepIndexOf('ava')).toBe(3);
    expect(steps.lastVerifiedStepIndex).toBe(2);
  });

  it("attaches a file made outside any step to the last step of the user whose app made it", async () => {
    const steps = new StepRecorder('attempt');
    const ava = steps.forUser('ava', AVA);
    await ava.run('app', 'app.open', '/invites', pass);
    await steps.run('app', 'app.open', '/', pass);
    ava.attachArtifact('her-video');
    steps.attachArtifact('my-video');
    expect(steps.all().map((step) => step.artifacts)).toEqual([['her-video'], ['my-video']]);
  });

  it('names the peer whose step waits at an e2e run --step hold', async () => {
    const held: StepHoldRequest[] = [];
    const steps = new StepRecorder('attempt', { hold: async (step) => void held.push(step) });
    steps.holdable = true;
    await steps.run('app', 'app.open', '/', pass);
    await steps.forUser('ava', AVA).run('app', 'app.open', '/invites', pass);
    expect(held.map((step) => [step.label, step.user])).toEqual([
      ['/', undefined],
      ['/invites', 'ava'],
    ]);
    expect(Object.hasOwn(held[0]!, 'user')).toBe(false);
  });
});
