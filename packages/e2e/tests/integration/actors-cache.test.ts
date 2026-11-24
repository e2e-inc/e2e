/**
 * The replay cache of an actor's agent steps, through the real browser
 * engine and a scripted model: an actor's `agent.act` records and replays
 * under the actor's name, so the same instruction given to the test's own
 * agent and to two actors is three recordings, each replayed by the session
 * that made it, whatever order the sessions act in.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';
import { cacheConfig, expectPassed, readEntries } from '../helpers/trace-cache.ts';

const TITLE = 'three sessions take the same instruction';
const CHECKED_ELSEWHERE = 'each session checks what the other did';
const NEVER_CHECKED = 'an actor acts and nothing checks it';
const CHECKED_INSIDE = 'an actor checks from inside its own act';
const CHECKED_INSIDE_BY_ACTOR = 'an actor checks from inside the act of the test';

/** The test under one order of its three `act` steps: the same instruction, each on its own screen. */
function suite(order: readonly ('own' | 'second' | 'third')[]): string {
  const steps = {
    own: `  await agent.act('finish the page');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');`,
    second: `  await second.agent.act('finish the page');
  await expect(second.screen.getByRole('status', { name: 'Marker' })).toHaveText('refreshed');`,
    third: `  await third.agent.act('finish the page');
  await expect(third.screen.getByRole('status', { name: 'Counter' })).toHaveText('1');`,
  };
  return `import { expect } from 'e2e';
import { test as base, actor } from '@e2e-dev/web';

const test = base.extend({ second: actor(), third: actor() });

test(${JSON.stringify(TITLE)}, async ({ app, agent, screen, second, third }) => {
  await app.open();
  await second.app.open('/feed');
  await third.app.open();
${order.map((who) => steps[who]).join('\n')}
});

test(${JSON.stringify(CHECKED_ELSEWHERE)}, async ({ app, agent, screen, second }) => {
  await app.open();
  await second.app.open();
  await agent.act('finish the page');
  await expect(second.screen.getByRole('status', { name: 'Counter' })).toHaveText('0');
  await second.agent.act('finish the page');
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
});

test(${JSON.stringify(NEVER_CHECKED)}, async ({ app, second }) => {
  await app.open();
  await second.app.open();
  await second.agent.act('finish the page');
});

test(${JSON.stringify(CHECKED_INSIDE_BY_ACTOR)}, async ({ app, agent, second }) => {
  await app.open();
  await second.app.open();
  await agent.act('finish the page', {
    onAction: async () => {
      await expect(second.screen.getByRole('status', { name: 'Counter' })).toBeVisible();
    },
  });
});

test(${JSON.stringify(CHECKED_INSIDE)}, async ({ app, second }) => {
  await app.open();
  await second.app.open();
  await second.agent.act('finish the page', {
    onAction: async () => {
      await expect(second.screen.getByRole('status', { name: 'Counter' })).toBeVisible();
    },
  });
});
`;
}

/** Acts on whichever screen the session shows: the counter, or the feed. */
function model() {
  return installFakeLoopModel((call) => {
    if (/"Counter" text="1"|"Marker" text="refreshed"/u.test(call.lastToolResult)) {
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'finished the page' } }];
    }
    if (call.lastToolResult !== '') throw new Error(`the page did not finish:\n${call.lastToolResult}`);
    const feed = call.prompt.includes('button "Refresh feed"');
    return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, feed ? /button "Refresh feed"/u : /button "Increment"/u) } }];
  });
}

describe("an actor's agent steps in the replay cache", () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let recorded: RunOutcome;
  let recordedModelCalls = 0;
  let replayed: RunOutcome;
  let strict: RunOutcome;

  const acts = (outcome: RunOutcome, title = TITLE) => resultByTitle(outcome, title).attempts.at(-1)!.steps.filter((step) => step.api === 'agent.act');

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/actors.e2e.ts': suite(['own', 'second', 'third']) });
    recorded = await runExisting(project, { appUrl: app.url, config: cacheConfig(model()) });
    recordedModelCalls = loopCalls.length;
    // The same steps in the opposite order: each session finds its own recording, not the first one made.
    writeFileSync(path.join(project.dir, 'tests/actors.e2e.ts'), suite(['third', 'second', 'own']), 'utf8');
    replayed = await runExisting(project, { appUrl: app.url, config: cacheConfig(model()) });
    strict = await runExisting(project, { appUrl: app.url, config: cacheConfig(model()), runOptions: { strictCache: true } });
  }, 240_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes on every run and reports each in the schema', () => {
    for (const outcome of [recorded, replayed, strict]) {
      expectPassed(outcome);
      assertValidReport(outcome.report);
    }
  });

  it('records one entry per session, each under its actor', () => {
    expect(recordedModelCalls).toBeGreaterThan(0);
    expect(acts(recorded).map((step) => [step.actor, step.cache?.mode, step.cache?.write])).toEqual([
      [undefined, 'missed', 'saved'],
      ['second', 'missed', 'saved'],
      ['third', 'missed', 'saved'],
    ]);
    const entries = readEntries(project).map(({ entry }) => entry.payload.recordedFor).filter((step) => step?.testId.endsWith(encodeURIComponent(TITLE)));
    expect(entries.map((step) => step?.actor).toSorted()).toEqual(['second', 'third', undefined].toSorted());
    // Each actor counts its own occurrences: all three are the first.
    expect(entries.map((step) => step?.callIndex)).toEqual([0, 0, 0]);
  });

  it('confirms an act with a check that passed on another session of the test', () => {
    // The test's own act is checked on the actor's screen, and the actor's on the test's.
    expect(acts(recorded, CHECKED_ELSEWHERE).map((step) => [step.actor, step.cache?.write])).toEqual([[undefined, 'saved'], ['second', 'saved']]);
    for (const step of acts(replayed, CHECKED_ELSEWHERE)) expect(step.cache, String(step.actor)).toMatchObject({ mode: 'self-finalized' });
  });

  it("does not count a check inside an actor's act as confirming that act", () => {
    // The check ran in the act's own onAction: it says nothing about where the act ended.
    expect(acts(recorded, CHECKED_INSIDE).map((step) => [step.actor, step.cache?.write])).toEqual([['second', 'unconfirmed']]);
  });

  it("does not count an actor's check inside the test's own act as confirming that act", () => {
    expect(acts(recorded, CHECKED_INSIDE_BY_ACTOR).map((step) => [step.actor, step.cache?.write])).toEqual([[undefined, 'unconfirmed']]);
  });

  it("keeps no recording of an actor's act that no check followed", () => {
    expect(acts(recorded, NEVER_CHECKED).map((step) => [step.actor, step.cache?.write])).toEqual([['second', 'unconfirmed']]);
    expect(acts(replayed, NEVER_CHECKED)[0]!.cache).toMatchObject({ mode: 'missed', reason: 'no-entry' });
  });

  it('replays each session from its own recording, in any order, with no model call', () => {
    const steps = acts(replayed);
    expect(steps.map((step) => step.actor)).toEqual(['third', 'second', undefined]);
    for (const step of steps) {
      expect(step.cache, String(step.actor)).toMatchObject({ mode: 'self-finalized', replayedActions: 1, totalActions: 1 });
      expect(step.metrics?.modelCalls).toBe(0);
    }
  });

  it('replays every session under --strict-cache', () => {
    for (const step of acts(strict)) expect(step.cache, String(step.actor)).toMatchObject({ mode: 'self-finalized' });
  });
});
