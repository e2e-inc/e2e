/**
 * Actors: more sessions in one test, each an `actor()` fixture. The runner
 * opens the actors a test names as attempts of their own on the engine,
 * beside the test's, before the test's clock starts; their steps are in the
 * test's record under the fixture's name, their video is kept beside its
 * own, and they close with the attempt. An actor's saved session selects
 * the setup test that saves it, and an actor on another target runs on that
 * target's engine, initialized once in the worker.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../src/run/runner.ts';
import { sendButton as scene, sessionSetups } from '../helpers/actor-project.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { engineFailure } from '../helpers/engine-runtime.ts';
import { resultByTitle, runProject, runProjectWithConfigFile, type FixtureProject } from '../helpers/run-project.ts';

const FIXTURES = `import { test as base } from 'e2e';
import { fakeActor as actor } from '../../../helpers/fake-engine.ts';

export const test = base.extend({
  reviewer: actor({ session: 'reviewer' }),
  guest: actor(),
  phone: actor({ target: 'phone' }),
  /** Both sessions on the page the test starts from. */
  room: async ({ app, reviewer }, use) => {
    await app.open('/room');
    await reviewer.app.open('/room');
    await use('/room');
  },
});
`;

const SUITE = `import { expect } from 'e2e';
import { test } from './fixtures.ts';

test('names no actor', async ({ app }) => {
  await app.open('/alone');
});

test('drives a second user between its own steps', { session: 'author' }, async ({ app, screen, reviewer }) => {
  await app.open('/board');
  await reviewer.app.open('/board');
  await screen.getByRole('button', 'Send').tap();
  await expect(reviewer.screen.getByRole('button', 'Send')).toBeVisible();
});

test('gets its actors through a fixture', async ({ room, guest }) => {
  await guest.app.open(room);
});

test('drives three sessions at once', async ({ app, reviewer, guest }) => {
  await Promise.all([app.open('/a'), reviewer.app.open('/b'), guest.app.open('/c')]);
});

test('fails on a step of its actor', async ({ app, reviewer }) => {
  await app.open('/board');
  await reviewer.app.open('/board/review');
  await reviewer.screen.getByRole('button', 'Never there').tap();
});

test.describe('past its timeout', () => {
  // The body's step on the actor was cut; the actor itself is open through teardown.
  test.afterEach(async ({ guest }) => {
    globalThis.actorsInTeardown = await guest.app.open('/in-teardown').then(() => 'still open', (cause) => cause.code);
  });

  test('times out while its actor waits', { timeout: 1_500 }, async ({ app, guest }) => {
    await app.open('/board');
    await guest.app.open('/board/guest');
    // The wait is capped by the test's deadline, where it and the test's timer end in the same tick: the body waits on neither.
    void guest.screen.getByRole('button', 'Never there').waitFor({ timeout: 60_000 }).catch(() => undefined);
    await new Promise(() => undefined);
  });
});

// The runner loads this file again for a retry, so the count lives on globalThis.
test('passes on its retry', { retries: 1 }, async ({ guest }) => {
  const tries = (globalThis.actorsTries = (globalThis.actorsTries ?? 0) + 1);
  await guest.app.open('/try-' + tries);
  if (tries === 1) throw new Error('the first try fails');
});

test.describe('with a step not awaited', () => {
  test.afterEach(async ({ guest }) => {
    globalThis.actorsAfterNotAwaited = await guest.app.open('/after').then(() => 'still open', (cause) => cause.code);
  });

  test('leaves a step of its actor running', async ({ guest }) => {
  await guest.app.open('/board');
    void guest.screen.getByRole('button', 'Never there').waitFor({ timeout: 60_000 }).catch(() => undefined);
  });
});

test('drives a phone beside its own session', async ({ app, phone }) => {
  await app.open('/order');
  await phone.app.open('/courier');
});

test('drives the phone again', async ({ phone }) => {
  await phone.app.open('/courier-again');
});
`;

/** The same engines as a config file a worker process loads, so each worker builds its own. */
const WORKER_CONFIG = `import type { E2EConfig } from 'e2e';
import { sendButton as scene } from '../../helpers/actor-project.ts';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  targets: [
    { name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true, actors: true, scene }).engine, app: FAKE_APP },
    { name: 'phone', platform: 'fake', engine: createFakeEngine({ scene }).engine, app: FAKE_APP },
  ],
  workers: 2,
} satisfies E2EConfig;
`;

const WORKER_SUITE = (name: string): string => `import { test } from './fixtures.ts';

test('${name} drives a second user and a phone', async ({ app, reviewer, phone }) => {
  await app.open('/${name}');
  await reviewer.app.open('/${name}');
  await phone.app.open('/${name}');
});
`;

describe('actors a test names', { timeout: 120_000 }, () => {
  let outcome: RunOutcome;
  let project: FixtureProject;
  let own: FakeEngineHandle;
  let phone: FakeEngineHandle;

  beforeAll(async () => {
    own = createFakeEngine({ video: true, state: true, actors: true, scene });
    phone = createFakeEngine({ video: true, scene });
    ({ outcome, project } = await runProject(
      { 'tests/fixtures.ts': FIXTURES, 'tests/auth.setup.e2e.ts': sessionSetups(['author', 'reviewer']), 'tests/actors.e2e.ts': SUITE },
      {
        config: {
          targets: [
            { name: 'fake', platform: 'fake', engine: own.engine, app: FAKE_APP },
            { name: 'phone', platform: 'fake', engine: phone.engine, app: FAKE_APP },
          ],
          video: 'on', trace: 'on', actionTimeout: 300, assertionTimeout: 300, cleanupTimeout: 2_000,
        },
        runOptions: { targetIds: ['fake'] },
      },
    ));
  });

  afterAll(() => project.cleanup());

  const attemptOf = (title: string, index = 0) => resultByTitle(outcome, title).attempts[index]!;
  const stepsOf = (title: string, index = 0) => attemptOf(title, index).steps.map((step) => `${step.actor ?? 'test'} ${step.api} ${step.label} ${step.status}`);

  it('writes a valid report', () => {
    assertValidReport(outcome.report);
  });

  it('runs the setup test an actor needs, for a test with no session of its own', () => {
    // `reviewer` is saved for the actor alone; `author` for the one test that starts from it.
    expect(resultByTitle(outcome, 'sign in as reviewer').status).toBe('passed');
    expect(resultByTitle(outcome, 'sign in as author').status).toBe('passed');
    expect(resultByTitle(outcome, 'gets its actors through a fixture').status).toBe('passed');
  });

  it('opens no actor for a test that names none', () => {
    expect(stepsOf('names no actor')).toEqual(['test app.open /alone passed']);
  });

  it("tells an actor's steps under the fixture's name, in the order they began", () => {
    expect(stepsOf('drives a second user between its own steps')).toEqual([
      'test app.open /board passed',
      'reviewer app.open /board passed',
      'test locator.tap getByRole("button", name: "Send") passed',
      'reviewer expect.toBeVisible getByRole("button", name: "Send") passed',
    ]);
  });

  it('opens the actors a fixture names, and the ones the test names beside it', () => {
    expect(stepsOf('gets its actors through a fixture')).toEqual(['test app.open /room passed', 'reviewer app.open /room passed', 'guest app.open /room passed']);
  });

  it('runs an attempt on the engine for each actor, beside the test\'s own', () => {
    expect(resultByTitle(outcome, 'drives three sessions at once').status).toBe('passed');
    expect(own.stats().maxConcurrentAttempts).toBe(3);
    expect(own.stats().attemptsEnded).toBe(own.stats().attemptsStarted);
  });

  it('restores the saved session into the actor that names it, and into no other', () => {
    const test = attemptOf('drives a second user between its own steps');
    const restores = own.operations.filter((operation) => operation.method === 'state.restore').map((operation) => operation.attemptId);
    // The test's own `author`, and the actor's `reviewer` on an attempt of its own.
    expect(restores.filter((attemptId) => attemptId === test.id)).toHaveLength(1);
    expect(new Set(restores).size).toBe(restores.length);
  });

  it("fails the test with the actor's step, named, and shows the actor's screen though the test's own is open", () => {
    const result = resultByTitle(outcome, 'fails on a step of its actor');
    expect(result.status).toBe('failed');
    const [attempt] = result.attempts;
    expect(attempt!.steps.at(-1)).toMatchObject({ actor: 'reviewer', api: 'locator.tap', status: 'failed' });
    expect(attempt!.error?.code).toBe('LOCATOR_NOT_FOUND');
    expect(attempt!.failure?.url).toBe(`${FAKE_APP_URL}/board/review`);
    const screen = attempt!.artifacts.find((artifact) => artifact.id === attempt!.failure?.screen)!;
    const page = readFileSync(path.join(project.dir, '.e2e', 'results', path.dirname(path.dirname(screen.path!)), 'trace.md'), 'utf8');
    expect(page).toContain('## Screen of reviewer at failure');
  });

  it("cuts an actor's step at the test's timeout, and leaves the actor open for teardown", () => {
    const result = resultByTitle(outcome, 'times out while its actor waits');
    expect(result.status).toBe('timed-out');
    const cut = result.attempts[0]!.steps.find((step) => step.api === 'locator.waitFor')!;
    expect(cut.actor).toBe('guest');
    expect(cut.status).not.toBe('passed');
    // Ended with the test's timeout, long before the minute it asked for.
    expect(cut.durationMs).toBeLessThan(10_000);
    expect((globalThis as { actorsInTeardown?: string }).actorsInTeardown).toBe('still open');
    // The screen at the failure is the one of the session whose step the timeout cut.
    expect(result.attempts[0]!.failure?.url).toBe(`${FAKE_APP_URL}/board/guest`);
  });

  it('opens a new actor for a retry', () => {
    const result = resultByTitle(outcome, 'passes on its retry');
    expect(result.status).toBe('flaky');
    expect(stepsOf('passes on its retry', 0)).toEqual(['guest app.open /try-1 passed']);
    expect(stepsOf('passes on its retry', 1)).toEqual(['guest app.open /try-2 passed']);
  });

  it('fails a test that leaves a step of its actor running', () => {
    const result = resultByTitle(outcome, 'leaves a step of its actor running');
    expect(result.status).toBe('failed');
    expect(result.attempts[0]!.error?.code).toBe('STEP_NOT_AWAITED');
    // The step was cut, and the actor was there for teardown, as the test's own session is.
    expect((globalThis as { actorsAfterNotAwaited?: string }).actorsAfterNotAwaited).toBe('still open');
  });

  it("keeps each actor's video beside the test's own, named after it", () => {
    const attempt = attemptOf('drives a second user between its own steps');
    const videos = attempt.artifacts.filter((artifact) => artifact.kind === 'video');
    expect(videos.map((video) => video.actor).toSorted()).toEqual(['reviewer', undefined].toSorted());
    const actors = videos.find((video) => video.actor === 'reviewer')!;
    expect(actors.path).toMatch(/actors\/reviewer\/video\/[^/]+$/);
    expect(existsSync(path.join(project.dir, '.e2e', 'results', actors.path!))).toBe(true);
  });

  it("runs an actor of another target on that target's engine, initialized once for the worker", () => {
    expect(stepsOf('drives a phone beside its own session')).toEqual(['test app.open /order passed', 'phone app.open /courier passed']);
    expect(stepsOf('drives the phone again')).toEqual(['phone app.open /courier-again passed']);
    expect(phone.stats()).toMatchObject({ inits: 1, attemptsStarted: 2, attemptsEnded: 2, disposes: 1 });
    // The phone's steps ran on the phone's engine, not on the test's own.
    expect(phone.callsOf(phone.attempts[0]!.attemptId, 'session').map((call) => call.url)).toEqual([`${FAKE_APP.url}/courier`]);
  });
});

describe('actors in worker processes', { timeout: 120_000 }, () => {
  it('opens each worker\'s actors on its own engines, another target\'s included', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/fixtures.ts': FIXTURES, 'tests/auth.setup.e2e.ts': sessionSetups(['author', 'reviewer']), 'tests/first.e2e.ts': WORKER_SUITE('first'), 'tests/second.e2e.ts': WORKER_SUITE('second') },
      { configSource: WORKER_CONFIG, runOptions: { targetIds: ['fake'] } },
    );
    try {
      expect(outcome.report.run.errors).toEqual([]);
      for (const name of ['first', 'second']) {
        const result = resultByTitle(outcome, `${name} drives a second user and a phone`);
        expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
        expect(result.attempts[0]!.steps.map((step) => `${step.actor ?? 'test'} ${step.label}`)).toEqual([`test /${name}`, `reviewer /${name}`, `phone /${name}`]);
      }
    } finally {
      project.cleanup();
    }
  });
});

describe('a failure an actor\'s engine holds from a path no step awaited', { timeout: 120_000 }, () => {
  it('fails the test, named after the actor, as one on the test\'s own session does', async () => {
    let thrown = false;
    // Attempt 0 is the test's own, attempt 1 its actor's: the actor's engine reports a handler that threw.
    const engine = createFakeEngine({
      actors: true,
      scene,
      onSettleAttempt: (index) => {
        if (index !== 1 || thrown) return;
        thrown = true;
        throw engineFailure('ENGINE_FAILURE', 'a route handler threw');
      },
    });
    const { outcome, project } = await runProject(
      {
        'tests/late.e2e.ts': `import { test as base } from 'e2e';
import { fakeActor as actor } from '../../../helpers/fake-engine.ts';

const test = base.extend({ guest: actor() });

test('its actor fails late', async ({ app, guest }) => {
  await app.open('/board');
  await guest.app.open('/board/guest');
});
`,
      },
      { config: { targets: [{ name: 'fake', platform: 'fake', engine: engine.engine, app: FAKE_APP }] } },
    );
    try {
      const result = resultByTitle(outcome, 'its actor fails late');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error).toMatchObject({ phase: 'body', message: expect.stringMatching(/^actor "guest": .*a route handler threw$/) });
      // The screen at the failure is the one of the session the failure came from.
      expect(result.attempts[0]!.failure?.url).toBe(`${FAKE_APP_URL}/board/guest`);
    } finally {
      project.cleanup();
    }
  });
});
