/**
 * The test's own session beside its actors: it opens when something drives
 * it, a built-in fixture the test, a fixture, or a hook names, or a
 * `session` the test sets, and not for a test that drives its actors alone.
 * `{ author, reviewer }` is then two sessions on the engine, each restored
 * from its saved state on every attempt, and a failure on one is told, and
 * shown, as that actor's.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArtifactStore, StoredArtifact } from '@e2e-dev/core/lib/types';
import type { RunOutcome } from '../../src/run/runner.ts';
import { sendButton as scene, sessionSetups } from '../helpers/actor-project.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const FIXTURES = `import { test as base } from 'e2e';
import { fakeActor as actor } from '../../../helpers/fake-engine.ts';

export const test = base.extend({
  author: actor({ session: 'editor-account' }),
  reviewer: actor({ session: 'review-account' }),
  visitor: actor({ session: 'visitor-account' }),
  /** A board the author and the reviewer both have open. */
  board: async ({ author, reviewer }, use) => {
    await author.app.open('/board');
    await reviewer.app.open('/board/review');
    await use({
      submit: () => author.screen.getByRole('button', 'Send').tap(),
      approve: (button) => reviewer.screen.getByRole('button', button).tap(),
    });
  },
});
`;

const SETUP = sessionSetups(['editor-account', 'review-account', 'visitor-account']);

const SUITE = `import { test } from './fixtures.ts';

// The runner loads this file again for a retry, so the count lives on globalThis.
test('a submission is approved', { retries: 1 }, async ({ board }) => {
  const tries = (globalThis.boardTries = (globalThis.boardTries ?? 0) + 1);
  await board.submit();
  await board.approve(tries === 1 ? 'Never there' : 'Send');
});

test('a visitor reads along', async ({ visitor }) => {
  await visitor.app.open('/board');
});
`;

const OWN = `import { expect } from 'e2e';
import { test as base } from './fixtures.ts';

const test = base.extend({
  /** A fixture that drives the test's own session. */
  opened: async ({ app }, use) => {
    await app.open('/own');
    await use('/own');
  },
});

test('drives its actors alone', async ({ author, reviewer }) => {
  await author.app.open('/a');
  await reviewer.app.open('/b');
});

test('fails on a value no session checked', async ({ author }) => {
  await author.app.open('/a');
  expect(1).toBe(2);
});

test('sets a session', { session: 'editor-account' }, async ({ reviewer }) => {
  await reviewer.app.open('/b');
});

test('names a built-in', async ({ platform, request, reviewer }) => {
  await reviewer.app.open('/' + platform + typeof request);
});

test('names only the platform', async ({ platform, reviewer }) => {
  await reviewer.app.open('/' + platform);
});

test('names a fixture that names a built-in', async ({ opened, reviewer }) => {
  await reviewer.app.open(opened);
});

test.describe('with a hook on the own session', () => {
  test.afterEach(async ({ app }) => {
    await app.open('/after');
  });

  test('has a hook that names a built-in', async ({ reviewer }) => {
    await reviewer.app.open('/b');
  });
});
`;

describe('a test that asks only for a fixture built on two actors', { timeout: 120_000 }, () => {
  let outcome: RunOutcome;
  let project: FixtureProject;
  let engine: FakeEngineHandle;

  beforeAll(async () => {
    engine = createFakeEngine({ state: true, actors: true, video: true, scene });
    ({ outcome, project } = await runProject(
      { 'tests/fixtures.ts': FIXTURES, 'tests/auth.setup.e2e.ts': SETUP, 'tests/board.e2e.ts': SUITE },
      {
        config: { targets: [{ name: 'fake', platform: 'fake', engine: engine.engine, app: FAKE_APP }], actionTimeout: 300, assertionTimeout: 300 },
        runOptions: { grep: [/a submission is approved/u] },
      },
    ));
  });

  afterAll(() => project.cleanup());

  const attempts = () => resultByTitle(outcome, 'a submission is approved').attempts;
  const setups = () => outcome.results.filter((result) => result.test.kind === 'setup' && result.attempts.length > 0).map((result) => result.test.title).toSorted();

  it('writes a valid report', () => {
    assertValidReport(outcome.report);
  });

  it('runs the login setups of the two actors the fixture names, and not the one of an actor nothing names', () => {
    expect(setups()).toEqual(['sign in as editor-account', 'sign in as review-account']);
  });

  it('opens two sessions on the engine for each attempt, and none for the test itself', () => {
    expect(attempts()).toHaveLength(2);
    // Two setups, then two actors on each of the two attempts.
    expect(engine.stats()).toMatchObject({ attemptsStarted: 6, attemptsEnded: 6, maxConcurrentAttempts: 2 });
    for (const attempt of attempts()) {
      expect(engine.operations.filter((operation) => operation.attemptId === attempt.id)).toEqual([]);
      expect(attempt.steps.every((step) => step.actor !== undefined)).toBe(true);
    }
  });

  it('fails the first attempt on the reviewer, and says so', () => {
    const [first] = attempts();
    expect(first!.status).toBe('failed');
    expect(first!.steps.at(-1)).toMatchObject({ actor: 'reviewer', api: 'locator.tap', status: 'failed' });
    expect(first!.error?.code).toBe('LOCATOR_NOT_FOUND');
  });

  it("shows the reviewer's screen as the screen at the failure, told as the reviewer's", () => {
    const [first] = attempts();
    expect(first!.failure?.url).toBe(`${FAKE_APP_URL}/board/review`);
    const screen = first!.artifacts.find((artifact) => artifact.id === first!.failure?.screen)!;
    expect(screen.actor).toBe('reviewer');
    expect(readFileSync(path.join(project.dir, '.e2e', 'results', screen.path!), 'utf8')).toContain('Send');
    // The engine wrote the screenshot under the reviewer's own directory: the record names the file where it is.
    const screenshot = first!.artifacts.find((artifact) => artifact.id === first!.failure?.screenshot)!;
    expect(screenshot).toMatchObject({ kind: 'screenshot', actor: 'reviewer', path: expect.stringContaining('/actors/reviewer/') });
    expect(existsSync(path.join(project.dir, '.e2e', 'results', screenshot.path!))).toBe(true);
  });

  it('starts each actor from its saved session again on the retry', () => {
    expect(resultByTitle(outcome, 'a submission is approved').status).toBe('flaky');
    const restores = engine.operations.filter((operation) => operation.method === 'state.restore').map((operation) => operation.attemptId);
    // One restore for each of the two actors on each attempt, every one into an attempt of its own.
    expect(restores).toHaveLength(4);
    expect(new Set(restores).size).toBe(4);
    expect(attempts()[1]!.steps.map((step) => `${step.actor} ${step.api} ${step.status}`)).toEqual([
      'author app.open passed', 'reviewer app.open passed', 'author locator.tap passed', 'reviewer locator.tap passed',
    ]);
  });
});

describe("the test's own session beside its actors", { timeout: 120_000 }, () => {
  let outcome: RunOutcome;
  let project: FixtureProject;
  let engine: FakeEngineHandle;

  const stored: StoredArtifact[] = [];
  const store: ArtifactStore = {
    async put(artifact) {
      stored.push(artifact);
      return { ref: `store://${artifact.path}` };
    },
  };

  beforeAll(async () => {
    engine = createFakeEngine({ state: true, actors: true, video: true, scene });
    ({ outcome, project } = await runProject(
      { 'tests/fixtures.ts': FIXTURES, 'tests/auth.setup.e2e.ts': SETUP, 'tests/own.e2e.ts': OWN },
      { config: { targets: [{ name: 'fake', platform: 'fake', engine: engine.engine, app: FAKE_APP }], video: 'on', artifacts: { store } } },
    ));
  });

  afterAll(() => project.cleanup());

  const attemptOf = (title: string) => resultByTitle(outcome, title).attempts[0]!;
  /** Whether the engine ran anything on the test's own attempt: its session opened. */
  const openedOwn = (title: string): boolean => engine.operations.some((operation) => operation.attemptId === attemptOf(title).id);

  it('passes but for the test that fails on purpose, with a valid report', () => {
    assertValidReport(outcome.report);
    expect(outcome.results.filter((result) => result.status !== 'passed').map((result) => result.test.title)).toEqual(['fails on a value no session checked']);
  });

  it('hands the artifact store what the report lists, each one time, and nothing else of an actor', () => {
    const listed = new Map(outcome.results.flatMap((result) => result.attempts.flatMap((attempt) => attempt.artifacts.map((artifact) => [artifact.path, attempt.id] as const))));
    expect(stored.length).toBeGreaterThan(0);
    for (const artifact of stored) expect(listed.get(artifact.path), artifact.path).toBe(artifact.attemptId);
    expect(new Set(stored.map((artifact) => artifact.path)).size).toBe(stored.length);
    const videos = stored.filter((artifact) => artifact.kind === 'video' && artifact.attemptId === attemptOf('drives its actors alone').id);
    expect(videos).toHaveLength(2);
  });

  it('opens none for a test that drives its actors alone, and keeps a video of each actor', () => {
    expect(openedOwn('drives its actors alone')).toBe(false);
    const videos = attemptOf('drives its actors alone').artifacts.filter((artifact) => artifact.kind === 'video');
    expect(videos.map((video) => video.actor).toSorted()).toEqual(['author', 'reviewer']);
  });

  it('has no screen to show for a failure that is not a step of a session', () => {
    const attempt = attemptOf('fails on a value no session checked');
    expect(attempt.status).toBe('failed');
    expect(attempt.failure).toBeUndefined();
  });

  it.each([
    ['the test sets a session', 'sets a session'],
    ['the test names a built-in fixture', 'names a built-in'],
    ['a fixture the test names does', 'names a fixture that names a built-in'],
    ['a hook of the test does', 'has a hook that names a built-in'],
  ])('opens it when %s', (_, title) => {
    expect(openedOwn(title)).toBe(true);
  });

  it('restores the session the test sets into its own, which nothing else drives', () => {
    const restored = engine.operations.filter((operation) => operation.method === 'state.restore' && operation.attemptId === attemptOf('sets a session').id);
    expect(restored).toHaveLength(1);
  });

  it('opens none for the platform, which the target alone decides', () => {
    expect(openedOwn('names only the platform')).toBe(false);
    expect(attemptOf('names only the platform').steps.map((step) => `${step.actor} ${step.label}`)).toEqual(['reviewer /fake']);
  });
});
