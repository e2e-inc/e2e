/**
 * Peers: more users in one test, each with an app of its own. These run the
 * built runner end to end on fixture projects: the web cases on a real
 * Chromium through child workers, which load the config a second time for
 * a peer's engine, and the lifecycle cases on the fake engine.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import type { HeldStep } from '../../src/run/step-hold.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { REFUSAL_EXPLANATION } from '../helpers/unserved-copilot-model.ts';
import {
  listProject,
  resultByTitle,
  runExistingWithConfigFile,
  runProject,
  runProjectWithConfigFile,
  workerConfigSource,
  type RunOutcome,
} from '../helpers/run-project.ts';

/** A web-like target and a second one a peer can run on, each with a fake engine that saves state. */
const TARGETS = [
  { name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
  { name: 'phone', platform: 'phone', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
];
const AGENTS = { default: {}, buyer: {}, ava: { context: 'You are Ava.' } };
/** The built engine API by file URL, which a package in a fixture project can import without resolving `e2e`. */
const BUILT_ENGINE_API = pathToFileURL(path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'dist', 'engine', 'index.js')).href;

/** The only result's first attempt, with the run errors for a readable failure. */
function onlyAttempt(outcome: RunOutcome, title: string) {
  const result = resultByTitle(outcome, title);
  return { result, attempt: result.attempts[0]!, why: JSON.stringify({ errors: result.attempts.map((attempt) => attempt.error), run: outcome.report.run.errors }) };
}

describe('peers: declared and listed', () => {
  it('lists each pair peers with the target each runs on and the agent each runs as', async () => {
    const files = {
      'tests/auth.setup.e2e.ts': `import { test } from 'e2e';
test.setup('sign in', { sessions: ['member', 'ava'] }, async () => {});
`,
      'tests/pay.e2e.ts': `import { test } from 'e2e';
test('pays', { platforms: ['fake'], session: 'member', peers: { ava: { target: 'phone', session: 'ava', agent: 'ava' }, bob: {} }, agent: ['buyer', 'ava'] }, async () => {});
test('alone', { platforms: ['fake'] }, async () => {});
`,
    };
    const { pairs, project } = await listProject(files, { config: { targets: TARGETS, agents: AGENTS } });
    try {
      const pays = pairs.filter((pair) => pair.title === 'pays' && pair.target === 'fake');
      expect(pays.map((pair) => [pair.agent, pair.peers])).toEqual([
        ['buyer', [{ name: 'ava', target: 'phone', session: 'ava', agent: 'ava' }, { name: 'bob', target: 'fake', session: undefined, agent: 'buyer' }]],
        ['ava', [{ name: 'ava', target: 'phone', session: 'ava', agent: 'ava' }, { name: 'bob', target: 'fake', session: undefined, agent: 'ava' }]],
      ]);
      expect(pairs.find((pair) => pair.title === 'alone')).not.toHaveProperty('peers');
      // The setup that saves Ava's session runs on her target as well as the test's own.
      expect(pairs.filter((pair) => pair.kind === 'setup' && pair.disposition === 'run').map((pair) => pair.target).toSorted()).toEqual(['fake', 'phone']);
    } finally {
      project.cleanup();
    }
  });
});

describe('peers on one web target', () => {
  let app: FixtureApp;
  beforeAll(async () => {
    app = await startFixtureApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const run = (files: Readonly<Record<string, string>>, extra = '') =>
    runProjectWithConfigFile(files, { appUrl: app.url, configSource: workerConfigSource(1, extra) });

  it('gives each user an app of its own: what one adds on the server the other sees, and their browser state stays apart', async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('pair', { peers: { ava: {} } }, async ({ app, screen, peers }) => {
  await app.open('/todos');
  await screen.getByLabel('New todo').fill('Oat milk');
  await screen.getByRole('button', 'Add').tap();
  await expect(screen.getByRole('status', 'Result')).toHaveText('added');
  await peers.ava.app.open('/todos');
  await expect(peers.ava.screen.getByText('Oat milk')).toBeVisible();

  await peers.ava.app.open('/storage');
  await peers.ava.screen.getByRole('button', 'Save marker').tap();
  await expect(peers.ava.screen.getByRole('status', 'Marker')).toHaveText('saved');
  await app.open('/storage');
  await expect(screen.getByRole('status', 'Marker')).toHaveText('empty');

  // Each user has its engine's own fixtures, on its own page.
  await expect(peers.ava.browser).toHaveURL('/storage');
  expect(peers.ava.platform).toBe('web');
  expect(Object.keys(peers)).toEqual(['ava']);
  let refused = '';
  try {
    void peers.bob;
  } catch (error) {
    refused = (error as Error).message;
  }
  if (!refused.startsWith('the test declares no peer "bob"; it declares "ava"')) throw new Error('an undeclared peer gave: ' + refused);
  // Probing the map as a promise does, or as an inspector does, is not asking for a peer.
  if ((await Promise.resolve(peers)) !== peers) throw new Error('awaiting the peers changed them');
});
`,
    });
    try {
      const { result, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('restores each user its own saved session', async () => {
    const { outcome, project } = await run({
      'tests/auth.setup.e2e.ts': `import { test, expect } from 'e2e';
test.setup('sign in both', { sessions: ['member', 'ava'] }, async ({ app, screen, session }) => {
  await app.open('/storage');
  await session.save('ava');
  await screen.getByRole('button', 'Save marker').tap();
  await expect(screen.getByRole('status', 'Marker')).toHaveText('saved');
  await session.save('member');
});
`,
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('signed in', { session: 'member', peers: { ava: { session: 'ava' }, guest: {} } }, async ({ app, screen, peers }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', 'Marker')).toHaveText('saved');
  await peers.ava.app.open('/storage');
  await expect(peers.ava.screen.getByRole('status', 'Marker')).toHaveText('empty');
  await peers.guest.app.open('/storage');
  await expect(peers.guest.screen.getByRole('status', 'Marker')).toHaveText('empty');
});
`,
    });
    try {
      const { result, why } = onlyAttempt(outcome, 'signed in');
      expect(result.status, why).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('hands peers to beforeEach, afterEach, and test.extend fixtures, and runs both users at once', async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test as base, expect } from 'e2e';
const test = base.extend<{ avaOnTodos: string }>({
  avaOnTodos: async ({ peers }, use) => {
    await peers.ava.app.open('/todos');
    await use('ready');
    await peers.ava.app.open('/storage');
  },
});
test.beforeEach(async ({ peers }) => {
  await expect(peers.ava.screen.getByRole('heading', 'Todos')).toBeVisible();
});
test.afterEach(async ({ peers }) => {
  await expect(peers.ava.screen.getByRole('heading', 'About')).toBeVisible();
});
test('together', { peers: { ava: {} } }, async ({ app, screen, peers, avaOnTodos }) => {
  expect(avaOnTodos).toBe('ready');
  await Promise.all([app.open('/storage'), peers.ava.app.open('/about')]);
  await Promise.all([
    expect(screen.getByRole('heading', 'Storage')).toBeVisible(),
    expect(peers.ava.screen.getByRole('heading', 'About')).toBeVisible(),
  ]);
});
`,
    });
    try {
      const { result, why } = onlyAttempt(outcome, 'together');
      expect(result.status, why).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('fails the test on a failing peer check, and keeps each user evidence in its own folder', async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('peer fails', { peers: { ava: {} } }, async ({ app, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
  await expect(peers.ava.screen.getByRole('heading', 'Nowhere')).toBeVisible({ timeout: 500 });
});
`,
    });
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'peer fails');
      expect(result.status, why).toBe('failed');
      expect(attempt.error?.code).toBe('ASSERTION_FAILED');
      const paths = attempt.artifacts.map((artifact) => artifact.path ?? '');
      expect(paths.some((file) => file.endsWith('/screen-at-failure.txt') && !file.includes('/peers/'))).toBe(true);
      const peerScreen = paths.find((file) => file.endsWith('/peers/ava/screen-at-failure.txt'));
      expect(peerScreen, JSON.stringify(paths)).toBeDefined();
      expect(readFileSync(path.join(project.dir, '.e2e', 'results', ...peerScreen!.split('/')), 'utf8')).toContain('About');
    } finally {
      project.cleanup();
    }
  });

  it('records a video for each user, in each user folder', async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test } from 'e2e';
test('filmed', { peers: { ava: {} }, video: 'on' }, async ({ app, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
});
`,
    });
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'filmed');
      expect(result.status, why).toBe('passed');
      const videos = attempt.artifacts.filter((artifact) => artifact.kind === 'video').map((artifact) => artifact.path ?? '');
      expect(videos.filter((file) => !file.includes('/peers/')), JSON.stringify(videos)).toHaveLength(1);
      expect(videos.filter((file) => file.includes('/peers/ava/video/')), JSON.stringify(videos)).toHaveLength(1);
      for (const file of videos) expect(existsSync(path.join(project.dir, '.e2e', 'results', ...file.split('/')))).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it('runs each user agent steps as its own agent, with its own context and memory, on its own screen', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
import { writeFileSync } from 'node:fs';
test('agents', { agentContext: 'Test user context.', peers: { ava: { agent: 'ava', agentContext: 'Peer context.' }, bob: {} } }, async ({ app, agent, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
  await peers.bob.app.open('/todos');
  const read = async (who: typeof agent) => JSON.parse((await who.act('report')).summary);
  const seen = { mine: await read(agent), hers: await read(peers.ava.agent), hersAgain: await read(peers.ava.agent), bobs: await read(peers.bob.agent) };
  writeFileSync(new URL('../agents.json', import.meta.url), JSON.stringify(seen));
});
`,
      },
      {
        appUrl: app.url,
        configSource: `import type { E2EConfig, StepExecutor } from 'e2e';
import { web } from '@e2e-dev/web';

// Reports what the step met: the agent's context, a count kept in its memory, and the pages its screen shows.
const report: StepExecutor = {
  name: 'report',
  version: '1',
  cache: 'off',
  async runStep(ctx) {
    const count = ((ctx.attempt.memory.get('count') as number | undefined) ?? 0) + 1;
    ctx.attempt.memory.set('count', count);
    const screen = await ctx.observe();
    const sees = ['Storage', 'About', 'Todos'].filter((page) => screen.text.includes(page));
    return { status: 'passed', summary: JSON.stringify({ context: ctx.agentContext, count, sees }) };
  },
};

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 1,
  agents: { default: { executor: report, context: 'Default agent.' }, ava: { executor: report, context: 'Ava agent.' } },
} satisfies E2EConfig;
`,
      },
    );
    try {
      const { result, why } = onlyAttempt(outcome, 'agents');
      expect(result.status, why).toBe('passed');
      const seen = JSON.parse(readFileSync(path.join(project.dir, 'agents.json'), 'utf8'));
      expect(seen.mine).toEqual({ context: 'Default agent.\nTest user context.', count: 1, sees: ['Storage'] });
      expect(seen.hers).toEqual({ context: 'Ava agent.\nPeer context.', count: 1, sees: ['About'] });
      expect(seen.hersAgain.count).toBe(2);
      expect(seen.bobs).toEqual({ context: 'Default agent.', count: 1, sees: ['Todos'] });
    } finally {
      project.cleanup();
    }
  });

  it('redacts a secret one user typed from what the other user reads of the screen', async () => {
    const TOKEN = 'synthetic-peer-token-2718';
    const { outcome, project } = await run(
      {
        'tests/pair.e2e.ts': `import { test, expect, secrets } from 'e2e';
test('shares a token', { peers: { ava: {} } }, async ({ app, screen, peers }) => {
  await app.open('/todos');
  await screen.getByLabel('New todo').fill(secrets.get('token'));
  await screen.getByRole('button', 'Add').tap();
  await expect(screen.getByRole('status', 'Result')).toHaveText('added');
  await peers.ava.app.open('/todos');
  // Ava's page shows the token, but what her agent reads of it never does.
  await expect(peers.ava.screen.getByRole('list', 'Todos')).toContainText('2718');
  const tree = await peers.ava.screen.tree();
  // The marker stands where the token was: nothing dropped the todo instead.
  if (!tree.includes('<secret:token>')) throw new Error('the peer screen read has no redaction marker: ' + tree);
  if (tree.includes('${TOKEN}')) throw new Error('the token reached the peer screen read');
});
`,
      },
      `\n  secrets: { token: () => '${TOKEN}' },`,
    );
    try {
      const { result, why } = onlyAttempt(outcome, 'shares a token');
      expect(result.status, why).toBe('passed');
      const report = readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8');
      expect(report).toContain('<secret:token>');
      expect(report).not.toContain(TOKEN);
    } finally {
      project.cleanup();
    }
  });

  it("labels each peer's steps, files, and app log lines in the report, keeps each user's environment apart, and adds no field for a test with no peers", async () => {
    const { outcome, project } = await run({
      'tests/solo.e2e.ts': `import { test, expect } from 'e2e';
test('solo', { video: 'on' }, async ({ app, screen }) => {
  await app.open('/nowhere-for-me');
  await app.open('/about');
  await expect(screen.getByRole('heading', 'Nowhere')).toBeVisible({ timeout: 500 });
});
`,
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('labelled', { peers: { ava: {} } }, async ({ app, screen, peers }) => {
  await app.open('/storage');
  await expect(screen.getByRole('heading', 'Storage')).toBeVisible();
  await peers.ava.app.open('/about');
  await expect(peers.ava.screen.getByRole('heading', 'About')).toBeVisible();
  await peers.ava.app.open('/nowhere-for-ava');
  await expect(screen.getByRole('heading', 'Storage')).toBeVisible();
  await peers.ava.app.screenshot('board');
  await app.screenshot('board');
});
`,
    });
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'labelled');
      expect(result.status, why).toBe('passed');
      const document = JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')) as unknown;
      assertValidReport(document);
      // The written report carries what the records do.
      const results = (document as { run: { results: { titlePath: string[]; attempts: Record<string, unknown>[] }[] } }).run.results;
      const pairAttempt = results.find((each) => each.titlePath.includes('labelled'))!.attempts[0]! as {
        steps: { user?: string }[];
        peers?: Record<string, { environment?: Record<string, string> }>;
      };
      expect(pairAttempt.steps.map((step) => step.user ?? null)).toEqual([null, null, 'ava', 'ava', 'ava', null, 'ava', null]);
      expect(pairAttempt.peers?.['ava']?.environment?.['browser']).toMatch(/chromium/u);
      const steps = attempt.steps.map((step) => [step.api, step.user ?? null]);
      expect(steps).toEqual([
        ['app.open', null],
        ['expect.toBeVisible', null],
        ['app.open', 'ava'],
        ['expect.toBeVisible', 'ava'],
        ['app.open', 'ava'],
        ['expect.toBeVisible', null],
        ['app.screenshot', 'ava'],
        ['app.screenshot', null],
      ]);
      const logged = (attempt.appLog ?? []).filter((line) => line.text.includes('/nowhere-for-ava'));
      expect(logged.length, JSON.stringify(attempt.appLog)).toBeGreaterThan(0);
      for (const line of logged) expect(line).toMatchObject({ user: 'ava', step: 4 });
      const shots = attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot').map((artifact) => [artifact.path, artifact.user ?? null]);
      expect(shots).toHaveLength(2);
      expect(shots.find(([, user]) => user === 'ava')?.[0]).toMatch(/\/peers\/ava\/screenshots\/[^/]*board[^/]*\.png$/u);
      expect(shots.find(([, user]) => user === null)?.[0]).not.toContain('/peers/');
      expect(attempt.peers?.['ava']?.environment?.['browser']).toBe(attempt.environment?.['browser']);
      expect(attempt.peers?.['ava']?.environment?.['browser']).toMatch(/chromium/u);

      // A test with no peers has everything a peer would label, and no field names a user.
      const solo = onlyAttempt(outcome, 'solo');
      expect(solo.result.status, solo.why).toBe('failed');
      expect(solo.attempt.appLog?.length).toBeGreaterThan(0);
      expect(solo.attempt.failure).toBeDefined();
      expect(solo.attempt.artifacts.some((artifact) => artifact.kind === 'video')).toBe(true);
      const keys: string[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (typeof value === 'object' && value !== null) {
          for (const [key, inner] of Object.entries(value)) {
            keys.push(key);
            walk(inner);
          }
        }
      };
      const written = (document as { run: { results: { titlePath: string[] }[] } }).run.results.find((each) => each.titlePath.includes('solo'));
      expect(written).toBeDefined();
      walk(written);
      expect(keys).not.toContain('user');
      expect(keys).not.toContain('peers');
    } finally {
      project.cleanup();
    }
  });

  it("keeps the failing peer's own screen as its failure evidence, under its name", async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('peer fails', { peers: { ava: {} } }, async ({ app, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
  await expect(peers.ava.screen.getByRole('heading', 'Nowhere')).toBeVisible({ timeout: 500 });
});
`,
    });
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'peer fails');
      expect(result.status, why).toBe('failed');
      expect(attempt.steps.at(-1)).toMatchObject({ api: 'expect.toBeVisible', user: 'ava', status: 'failed' });
      const hers = attempt.peers?.['ava']?.failure;
      expect(hers?.url, JSON.stringify(attempt.peers)).toMatch(/\/about$/u);
      expect(attempt.failure?.url).toMatch(/\/storage$/u);
      const screen = attempt.artifacts.find((artifact) => artifact.id === hers?.screen);
      expect(screen).toMatchObject({ user: 'ava' });
      expect(screen?.path).toMatch(/\/peers\/ava\/screen-at-failure\.txt$/u);
    } finally {
      project.cleanup();
    }
  });

  it("keeps each user's toHaveScreenshot baseline of one name in a file of its own", async () => {
    const { outcome, project } = await run({
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('baselines', { peers: { ava: {} } }, async ({ app, screen, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
  await expect.soft(screen).toHaveScreenshot('page');
  await expect.soft(peers.ava.screen).toHaveScreenshot('page');
});
`,
    });
    try {
      // The first run has no stored screenshots: each user's is written to its own file.
      const first = onlyAttempt(outcome, 'baselines');
      expect(first.result.status, first.why).toBe('failed');
      const snapshots = path.join(project.dir, 'tests', 'pair.e2e.ts-snapshots');
      const suffix = `-web-${process.platform}.png`;
      const mine = path.join(snapshots, `page${suffix}`);
      // Hers sits under the test's own target, then her name.
      const hers = path.join(snapshots, 'peers', 'web', 'ava', `page${suffix}`);
      expect(existsSync(mine)).toBe(true);
      expect(existsSync(hers)).toBe(true);
      expect(readFileSync(hers).equals(readFileSync(mine))).toBe(false);
      // Each user's screen then matches its own.
      const second = onlyAttempt(await runExistingWithConfigFile(project, { appUrl: app.url }), 'baselines');
      expect(second.result.status, second.why).toBe('passed');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('holds each user step under e2e run --step, the peer named, including two called together', async () => {
    const held: HeldStep[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('stepped', { peers: { ava: {} } }, async ({ app, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
  await Promise.all([app.open('/todos'), peers.ava.app.open('/storage')]);
});
`,
      },
      {
        appUrl: app.url,
        configSource: workerConfigSource(1),
        runOptions: {
          beforeStep: async (step) => {
            held.push(step);
          },
        },
      },
    );
    try {
      const { result, why } = onlyAttempt(outcome, 'stepped');
      expect(result.status, why).toBe('passed');
      expect(held.map((step) => [step.label, step.user ?? null]).toSorted()).toEqual(
        [
          ['/storage', null],
          ['/about', 'ava'],
          ['/todos', null],
          ['/storage', 'ava'],
        ].toSorted(),
      );
      expect(held.slice(0, 2).map((step) => step.user ?? null)).toEqual([null, 'ava']);
    } finally {
      project.cleanup();
    }
  });

  /** A config whose one agent reads the screen, then reports, as its step summary, the earlier steps its prompt was given. */
  const ledgerConfig = `import type { E2EConfig, StepExecutor } from 'e2e';
import { web } from '@e2e-dev/web';

const ledger: StepExecutor = {
  name: 'ledger',
  version: '1',
  cache: 'off',
  async runStep(ctx) {
    const seen = await ctx.observe({ pixels: true });
    if (seen.pixels !== undefined) await ctx.attachScreenshot(seen.pixels, 'look');
    return { status: 'passed', summary: ctx.ledger };
  },
};

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 1,
  agents: { default: { executor: ledger } },
} satisfies E2EConfig;
`;

  it("tells each user's agent only that user's earlier steps, and compares each user's screens with that user's own", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
import { writeFileSync } from 'node:fs';
test('histories', { peers: { ava: {} } }, async ({ app, agent, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/about');
  await agent.act('note the storage page');
  await peers.ava.agent.act('note the about page');
  const mine = (await agent.act('tell what came before')).summary;
  const hers = (await peers.ava.agent.act('tell what came before')).summary;
  writeFileSync(new URL('../ledgers.json', import.meta.url), JSON.stringify({ mine, hers }));
});
`,
      },
      { appUrl: app.url, configSource: ledgerConfig },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'histories');
      expect(result.status, why).toBe('passed');
      // Each agent step saw its own user's screen; a later one compares with that user's earlier one, not the other user's.
      const acts = attempt.steps.filter((step) => step.api === 'agent.act');
      expect(acts.map((step) => [step.user ?? null, step.screen?.location])).toEqual([
        [null, `${app.url}/storage`],
        ['ava', `${app.url}/about`],
        [null, `${app.url}/storage`],
        ['ava', `${app.url}/about`],
      ]);
      const opens = attempt.steps.filter((step) => step.api === 'app.open');
      expect(acts.map((step) => step.screen?.since)).toEqual([opens[0]!.index, opens[1]!.index, acts[0]!.index, acts[1]!.index]);
      for (const step of acts) expect(step.screen?.changes).toEqual([]);
      // A tool's screenshot of one label is a file in each user's own folder.
      const looks = attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot' && (artifact.path ?? '').endsWith('/look.png'));
      expect(looks.map((artifact) => artifact.user ?? null).toSorted(), JSON.stringify(attempt.artifacts)).toEqual(['ava', 'ava', null, null].toSorted());
      expect(new Set(looks.filter((artifact) => artifact.user === 'ava').map((artifact) => artifact.path)).size).toBe(1);
      expect(looks.filter((artifact) => artifact.user === 'ava').every((artifact) => artifact.path?.includes('/peers/ava/'))).toBe(true);
      expect(looks.filter((artifact) => artifact.user === undefined).every((artifact) => !artifact.path?.includes('/peers/'))).toBe(true);
      const { mine, hers } = JSON.parse(readFileSync(path.join(project.dir, 'ledgers.json'), 'utf8')) as { mine: string; hers: string };
      expect(mine).toContain('note the storage page');
      expect(mine).toContain('/storage');
      expect(mine).not.toContain('note the about page');
      expect(mine).not.toContain('/about');
      expect(hers).toContain('note the about page');
      expect(hers).toContain('/about');
      expect(hers).not.toContain('note the storage page');
      expect(hers).not.toContain('/storage');
    } finally {
      project.cleanup();
    }
  });
});

describe('peers on another web target', () => {
  let app: FixtureApp;
  let other: FixtureApp;
  beforeAll(async () => {
    app = await startFixtureApp();
    other = await startFixtureApp();
    process.env['OTHER_URL'] = other.url;
  });
  afterAll(async () => {
    delete process.env['OTHER_URL'];
    await app.close();
    await other.close();
  });

  /** The test's own Chromium target, and another on its own app, in French. */
  const twoTargets = (otherApp: string) => `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [
    { name: 'web', engine: web(), app: { url: process.env.APP_URL! } },
    { name: 'french', engine: web({ locale: 'fr-FR' }), app: ${otherApp} },
  ],
  workers: 1,
} satisfies E2EConfig;
`;

  it("runs a peer on another web target, on that target's own engine, app, and saved login", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/auth.setup.e2e.ts': `import { test, expect } from 'e2e';
test.setup('sign in ava', { sessions: ['ava'] }, async ({ app, screen, session }) => {
  await app.open('/storage');
  await screen.getByRole('button', 'Save marker').tap();
  await expect(screen.getByRole('status', 'Marker')).toHaveText('saved');
  await session.save('ava');
});
`,
        'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('across', { peers: { ava: { target: 'french', session: 'ava' } } }, async ({ app, peers }) => {
  await app.open('/storage');
  await peers.ava.app.open('/storage');
  await expect(peers.ava.screen.getByRole('status', 'Marker')).toHaveText('saved');
  const where = await peers.ava.browser.url();
  if (!where.startsWith(process.env.OTHER_URL!)) throw new Error('Ava opened ' + where);
  const language = await peers.ava.browser.evaluate('navigator.language');
  if (language !== 'fr-FR') throw new Error('Ava runs in ' + language);
});
`,
      },
      { appUrl: app.url, configSource: twoTargets('{ url: process.env.OTHER_URL! }') },
    );
    try {
      // The test runs on each target as its own, as every test does; its peer is on "french" both times.
      const results = outcome.results.filter((result) => result.test.title === 'across');
      expect(results.map((result) => [result.target.name, result.status]).toSorted()).toEqual([
        ['french', 'passed'],
        ['web', 'passed'],
      ]);
      const document = JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')) as unknown;
      assertValidReport(document);
      const onWeb = results.find((result) => result.target.name === 'web')!.attempts[0]!;
      expect(onWeb.peers?.['ava']?.target).toBe('french');
      expect(onWeb.peers?.['ava']?.environment?.['browser']).toMatch(/chromium/u);
      expect(onWeb.steps.filter((step) => step.user === 'ava').map((step) => step.api)).toEqual(['app.open', 'expect.toHaveText', 'browser.url', 'browser.evaluate']);
      // The test's own user stays on its own app: its main page was the first app's.
      expect(app.url).not.toBe(other.url);
    } finally {
      project.cleanup();
    }
  });

  it("starts the app command of a peer's target once for the run, on the free port the run chose for it", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'other-app.mjs': `import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync(new URL('./started.log', import.meta.url), 'started\\n');
createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>Other</title><h1>Other app</h1>');
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
        'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('across', { peers: { ava: { target: 'french' } } }, async ({ app, peers }) => {
  await app.open('/');
  await peers.ava.app.open('/');
  await expect(peers.ava.screen.getByRole('heading', 'Other app')).toBeVisible();
});
`,
      },
      {
        appUrl: app.url,
        configSource: twoTargets(`{ url: 'http://127.0.0.1:0', command: { executable: process.execPath, args: ['other-app.mjs'], env: { PORT: '{port}' } } }`),
      },
    );
    try {
      const results = outcome.results.filter((result) => result.test.title === 'across');
      expect(results.map((result) => [result.target.name, result.status, JSON.stringify(result.attempts[0]?.error ?? null)]).toSorted()).toEqual([
        ['french', 'passed', 'null'],
        ['web', 'passed', 'null'],
      ]);
      expect(readFileSync(path.join(project.dir, 'started.log'), 'utf8')).toBe('started\n');
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

/**
 * A config with a phone target on the fake engine whose `prepare` serves
 * `devices` slots, a device each, and hands its workers which device every
 * slot drives. Each `prepare` and each engine start is a line of `pool.log`.
 */
function poolConfig(devices: number, workers: number, phones = ''): string {
  return `import type { E2EConfig } from 'e2e';
import { appendFileSync } from 'node:fs';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const log = (line: string) => appendFileSync(new URL('./pool.log', import.meta.url), line + '\\n');
const phones = createFakeEngine({
  prepare: (info) => {
    if (info.slots === 0) return {};
    log('prepare ' + JSON.stringify({ slots: info.slots, peerSlots: info.peerSlots ?? null }));
    const bound = Math.min(info.slots, ${devices});
    return { workers: bound, env: { FAKE_POOL: Array.from({ length: bound }, (_, slot) => 'device-' + slot).join(',') } };
  },
  onInit: (info) => log('init ' + JSON.stringify({ slot: info.workerSlot, device: (info.env.FAKE_POOL ?? '').split(',')[info.workerSlot] ?? null })),
  ${phones}
}).engine;

export default {
  targets: [
    { name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
    { name: 'phones', platform: 'ios', engine: phones, app: FAKE_APP },
  ],
  workers: ${workers},
} satisfies E2EConfig;
`;
}

/** The lines of `pool.log` that start with `kind`, parsed. */
function poolLines(projectDir: string, kind: 'prepare' | 'init'): Record<string, unknown>[] {
  const file = path.join(projectDir, 'pool.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.startsWith(`${kind} `))
    .map((line) => JSON.parse(line.slice(kind.length + 1)) as Record<string, unknown>);
}

describe('peers: a slot of its own on the peer target', () => {
  /** Two files whose test holds its worker a moment, so the run's two workers are live together. */
  const twoFiles = (options: string) =>
    Object.fromEntries(
      ['a', 'b'].map((name) => [
        `tests/${name}.e2e.ts`,
        `import { test } from 'e2e';
test('${name}', ${options}, async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
});
`,
      ]),
    );
  const runPool = async (files: Readonly<Record<string, string>>, devices: number, workers: number) => {
    const notices: string[] = [];
    const { outcome, project } = await runProjectWithConfigFile(files, {
      configSource: poolConfig(devices, workers),
      runOptions: {
        onEvent: (event) => {
          if (event.type === 'notice' && event.target === 'run') notices.push(event.message);
        },
      },
    });
    return { outcome, project, notices };
  };
  const statuses = (outcome: RunOutcome, target: string) =>
    outcome.results
      .filter((result) => result.target.name === target)
      .map((result) => [result.test.title, result.status, result.attempts[0]?.error?.message ?? null])
      .toSorted();

  it("asks a phone target for a slot per peer and starts each worker's peer on its own, with the device that slot was bound", async () => {
    const { outcome, project, notices } = await runPool(twoFiles(`{ platforms: ['fake'], peers: { ava: { target: 'phones' } } }`), 2, 2);
    try {
      expect(statuses(outcome, 'fake')).toEqual([
        ['a', 'passed', null],
        ['b', 'passed', null],
      ]);
      // The target runs no test of its own: both slots are for the two workers' peers.
      expect(poolLines(project.dir, 'prepare')).toEqual([{ slots: 2, peerSlots: 2 }]);
      expect(poolLines(project.dir, 'init').toSorted((a, b) => Number(a['slot']) - Number(b['slot']))).toEqual([
        { slot: 0, device: 'device-0' },
        { slot: 1, device: 'device-1' },
      ]);
      expect(notices.filter((line) => line.includes('at a time'))).toEqual([]);
    } finally {
      project.cleanup();
    }
    // A run with no peer names no peer slot to the engine.
    const alone = await runPool(twoFiles(`{ platforms: ['ios'] }`), 2, 2);
    try {
      expect(statuses(alone.outcome, 'phones')).toEqual([
        ['a', 'passed', null],
        ['b', 'passed', null],
      ]);
      expect(poolLines(alone.project.dir, 'prepare')).toEqual([{ slots: 2, peerSlots: null }]);
    } finally {
      alone.project.cleanup();
    }
  }, 120_000);

  it("lets the run's own variable win over what the peer target's prepare handed, as for that target's own workers", async () => {
    process.env['FAKE_POOL'] = 'from-the-run-0,from-the-run-1';
    try {
      const { outcome, project } = await runPool(twoFiles(`{ platforms: ['fake'], peers: { ava: { target: 'phones' } } }`), 2, 2);
      try {
        expect(statuses(outcome, 'fake')).toEqual([
          ['a', 'passed', null],
          ['b', 'passed', null],
        ]);
        expect(poolLines(project.dir, 'init').map((line) => line['device']).toSorted()).toEqual(['from-the-run-0', 'from-the-run-1']);
      } finally {
        project.cleanup();
      }
    } finally {
      delete process.env['FAKE_POOL'];
    }
  });

  it('runs fewer workers, and says so, when the phone target serves fewer slots than the workers peers need', async () => {
    const { outcome, project, notices } = await runPool(twoFiles(`{ platforms: ['fake'], peers: { ava: { target: 'phones' } } }`), 1, 2);
    try {
      expect(statuses(outcome, 'fake')).toEqual([
        ['a', 'passed', null],
        ['b', 'passed', null],
      ]);
      expect(notices.filter((line) => line.includes('at a time'))).toEqual([
        'target "fake" runs 1 worker at a time, not 2: the peers of tests take slots of their own on their targets, and an engine serves only so many at once',
      ]);
      // One worker ran both files, so one peer engine started, on the one device.
      expect(poolLines(project.dir, 'init')).toEqual([{ slot: 0, device: 'device-0' }]);
    } finally {
      project.cleanup();
    }
  });

  it("keeps a test's own user and its peer on two slots of one phone target, a worker fewer for each peer", async () => {
    const { outcome, project, notices } = await runPool(twoFiles(`{ platforms: ['ios'], peers: { ava: {} } }`), 2, 2);
    try {
      expect(statuses(outcome, 'phones')).toEqual([
        ['a', 'passed', null],
        ['b', 'passed', null],
      ]);
      // Two workers with a peer each would need four devices; the two serve one worker and its peer.
      expect(poolLines(project.dir, 'prepare')).toEqual([{ slots: 4, peerSlots: 2 }]);
      expect(notices.filter((line) => line.includes('at a time'))).toEqual([
        'target "phones" runs 1 worker at a time, not 2: the peers of tests take slots of their own on their targets, and an engine serves only so many at once',
      ]);
      const starts = poolLines(project.dir, 'init');
      expect(starts.toSorted((a, b) => Number(a['slot']) - Number(b['slot']))).toEqual([
        { slot: 0, device: 'device-0' },
        { slot: 1, device: 'device-1' },
      ]);
    } finally {
      project.cleanup();
    }
  });

  it("runs no more of a phone target's own workers than the fit left room for beside the peers it hosts, when its prepare serves more", async () => {
    // The engine serves one worker of its own; prepare, asked for that worker's slot and the web test's peer's, serves both.
    const files = {
      'tests/web.e2e.ts': `import { test } from 'e2e';
test('web', { platforms: ['fake'], peers: { ava: { target: 'phones' } } }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
});
`,
      ...Object.fromEntries(
        ['p1', 'p2'].map((name) => [
          `tests/${name}.e2e.ts`,
          `import { test } from 'e2e';
test('${name}', { platforms: ['ios'] }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
});
`,
        ]),
      ),
    };
    const { outcome, project } = await runProjectWithConfigFile(files, { configSource: poolConfig(4, 8, 'workers: 1,') });
    try {
      expect(outcome.results.filter((result) => result.status !== 'skipped').map((result) => [result.test.title, result.target.name, result.status]).toSorted()).toEqual([
        ['p1', 'phones', 'passed'],
        ['p2', 'phones', 'passed'],
        ['web', 'fake', 'passed'],
      ]);
      expect(poolLines(project.dir, 'prepare')).toEqual([{ slots: 2, peerSlots: 1 }]);
      // One phone worker ran both phone files on slot 0; the web test's peer had slot 1 to itself.
      expect(poolLines(project.dir, 'init').toSorted((a, b) => Number(a['slot']) - Number(b['slot']))).toEqual([
        { slot: 0, device: 'device-0' },
        { slot: 1, device: 'device-1' },
      ]);
    } finally {
      project.cleanup();
    }
  });

  it("runs no more of a phone target's workers than the fit when its prepare serves its own tests' peers too, past the engine's own bound", async () => {
    // The engine serves two workers; prepare, asked for theirs and their peers' four slots, serves all four.
    const files = Object.fromEntries(
      ['p1', 'p2', 'p3', 'p4'].map((name) => [
        `tests/${name}.e2e.ts`,
        `import { test } from 'e2e';
test('${name}', { platforms: ['ios'], peers: { ava: {} } }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
});
`,
      ]),
    );
    const { outcome, project } = await runProjectWithConfigFile(files, { configSource: poolConfig(4, 8, 'workers: 2,') });
    try {
      expect(outcome.results.filter((result) => result.status !== 'skipped').map((result) => [result.test.title, result.target.name, result.status]).toSorted()).toEqual([
        ['p1', 'phones', 'passed'],
        ['p2', 'phones', 'passed'],
        ['p3', 'phones', 'passed'],
        ['p4', 'phones', 'passed'],
      ]);
      expect(poolLines(project.dir, 'prepare')).toEqual([{ slots: 4, peerSlots: 2 }]);
      // Two workers on slots 0 and 1, their peers on 2 and 3: each slot started once, on its own device.
      expect(poolLines(project.dir, 'init').toSorted((a, b) => Number(a['slot']) - Number(b['slot']))).toEqual([
        { slot: 0, device: 'device-0' },
        { slot: 1, device: 'device-1' },
        { slot: 2, device: 'device-2' },
        { slot: 3, device: 'device-3' },
      ]);
    } finally {
      project.cleanup();
    }
  });

  it('fails the run before any test when a phone target cannot serve one worker and its peer', async () => {
    const { outcome, project } = await runPool(twoFiles(`{ platforms: ['ios'], peers: { ava: {} } }`), 1, 2);
    try {
      expect(outcome.results.filter((result) => result.attempts.length > 0)).toEqual([]);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.report.run.errors.map((error) => [error.code, error.phase, error.message])).toEqual([
        [
          'ENGINE_FAILURE',
          'launch',
          'target "phones" serves 1 at once, and this run needs 2 of it at once with one worker per target: 1 for its own worker, 1 for the peer of one of its own tests; a peer takes a slot of its own, a device on a phone target, so give the target more, or keep the tests that put a peer on it out of this run',
        ],
      ]);
      expect(poolLines(project.dir, 'init')).toEqual([]);
    } finally {
      project.cleanup();
    }
  });
});

describe('peers: targets a peer cannot run on', () => {
  it("fails the run before any test, with the engine's own code, when a peer's target leases its browsers from a provider", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('pair', { platforms: ['fake'], peers: { ava: { target: 'cloud' } } }, async () => {});
`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { appendFileSync } from 'node:fs';
import { web } from '@e2e-dev/web';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const cloud = {
  name: 'toy-cloud',
  async acquire() {
    appendFileSync(new URL('./leases.log', import.meta.url), 'acquired\\n');
    return { id: 'lease', cdpEndpoint: 'ws://127.0.0.1:9' };
  },
  async release() {},
};

export default {
  targets: [
    { name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
    { name: 'cloud', engine: web({ browser: cloud }), app: { url: 'http://127.0.0.1:4599' } },
  ],
  workers: 1,
} satisfies E2EConfig;
`,
      },
    );
    try {
      expect(outcome.results.filter((result) => result.attempts.length > 0)).toEqual([]);
      expect(outcome.report.run.errors.map((error) => [error.code, error.phase, error.message])).toEqual([
        [
          'UNSUPPORTED_CAPABILITY',
          'launch',
          'target "cloud" leases its browsers from toy-cloud, and a test\'s peer on it would need a lease of its own, which this version does not take for a peer; run the peer on a target that launches its browser on this machine',
        ],
      ]);
      expect(existsSync(path.join(project.dir, 'leases.log'))).toBe(false);
    } finally {
      project.cleanup();
    }
  });
});

describe('peers: the replay cache', () => {
  let app: FixtureApp;
  beforeAll(async () => {
    app = await startFixtureApp();
  });
  afterAll(async () => {
    await app.close();
  });

  /** A config whose one agent taps Increment twice, through actions the replay cache records, and logs each time it runs. */
  const counterConfig = `import type { E2EConfig, StepExecutor } from 'e2e';
import { appendFileSync } from 'node:fs';
import { web } from '@e2e-dev/web';

const twice: StepExecutor = {
  name: 'twice',
  version: '1',
  async runStep(ctx) {
    appendFileSync(new URL('./calls.log', import.meta.url), ctx.step.instruction + '\\n');
    const screen = await ctx.observe();
    const line = screen.text.split('\\n').find((row) => row.includes('button "Increment"'));
    const id = /#(\\S+)/u.exec(line ?? '')?.[1];
    if (id === undefined) return { status: 'failed', summary: 'There is no Increment button.' };
    await ctx.actions.tap({ id });
    await ctx.actions.tap({ id });
    return { status: 'passed', summary: 'Incremented the counter twice.' };
  },
};

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 1,
  cache: { mode: 'read-write' },
  agents: { default: { executor: twice } },
} satisfies E2EConfig;
`;

  const calls = (project: { dir: string }): string[] =>
    existsSync(path.join(project.dir, 'calls.log')) ? readFileSync(path.join(project.dir, 'calls.log'), 'utf8').trim().split('\n') : [];

  it('keeps a recording for each user of one step, and each replays its own when the two run in the other order', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
import { existsSync } from 'node:fs';
const reversed = existsSync(new URL('../reversed', import.meta.url));
test('both count', { peers: { ava: {} } }, async ({ app, agent, screen, peers }) => {
  await app.open('/');
  await peers.ava.app.open('/');
  const mine = async () => {
    await agent.act('increment the counter twice');
    await expect(screen.getByRole('status', 'Counter')).toHaveText('2');
  };
  const hers = async () => {
    await peers.ava.agent.act('increment the counter twice');
    await expect(peers.ava.screen.getByRole('status', 'Counter')).toHaveText('2');
  };
  if (reversed) {
    await hers();
    await mine();
  } else {
    await mine();
    await hers();
  }
});
`,
      },
      { appUrl: app.url, configSource: counterConfig },
    );
    try {
      const first = onlyAttempt(outcome, 'both count');
      expect(first.result.status, first.why).toBe('passed');
      const acts = first.attempt.steps.filter((step) => step.api === 'agent.act');
      expect(acts.map((step) => [step.user ?? null, step.cache?.write])).toEqual([
        [null, 'saved'],
        ['ava', 'saved'],
      ]);
      expect(acts[0]!.cache?.entry).not.toBe(acts[1]!.cache?.entry);
      expect(calls(project)).toHaveLength(2);
      const entries = readdirSync(path.join(project.dir, '.e2e', 'cache'), { recursive: true }).filter((file) => String(file).endsWith('.json'));
      expect(entries).toHaveLength(2);

      writeFileSync(path.join(project.dir, 'reversed'), '');
      const second = await runExistingWithConfigFile(project, { appUrl: app.url });
      const again = onlyAttempt(second, 'both count');
      expect(again.result.status, again.why).toBe('passed');
      const replayed = again.attempt.steps.filter((step) => step.api === 'agent.act');
      expect(replayed.map((step) => [step.user ?? null, step.cache?.mode, step.cache?.entry])).toEqual([
        ['ava', 'self-finalized', acts[1]!.cache?.entry],
        [null, 'self-finalized', acts[0]!.cache?.entry],
      ]);
      // Nothing called the agent: both steps replayed.
      expect(calls(project)).toHaveLength(2);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it("keeps a recording of a peer's step for each agent a test runs as, though the peer runs as one agent in both", async () => {
    const files = {
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('sweep', { agent: ['admin', 'member'], peers: { ava: { agent: 'guest' } } }, async ({ app, peers }) => {
  await app.open('/');
  await peers.ava.app.open('/');
  await peers.ava.agent.act('increment the counter twice');
  await expect(peers.ava.screen.getByRole('status', 'Counter')).toHaveText('2');
});
`,
    };
    const configSource = counterConfig.replace('agents: { default: { executor: twice } },', 'agents: { default: { executor: twice }, admin: { executor: twice }, member: { executor: twice }, guest: { executor: twice } },');
    const { outcome, project } = await runProjectWithConfigFile(files, { appUrl: app.url, configSource });
    try {
      const acts = outcome.results.map((result) => [result.agent, result.status, result.attempts[0]?.steps.find((step) => step.api === 'agent.act')?.cache?.write ?? null]);
      // Each pair's peer recorded its own step: the admin pair's recording never stands in for the member pair's.
      expect(acts.toSorted()).toEqual([
        ['admin', 'passed', 'saved'],
        ['member', 'passed', 'saved'],
      ]);
      expect(calls(project)).toHaveLength(2);
      const entries = readdirSync(path.join(project.dir, '.e2e', 'cache'), { recursive: true }).filter((file) => String(file).endsWith('.json'));
      expect(entries).toHaveLength(2);
    } finally {
      project.cleanup();
    }
  });

  it("keeps a peer's recordings and screenshot baselines for each target the test runs on, though the peer runs on one", async () => {
    const files = {
      'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('two targets', { peers: { ava: { target: 'web' } } }, async ({ app, peers }) => {
  await app.open('/');
  await peers.ava.app.open('/');
  await peers.ava.agent.act('increment the counter twice');
  await expect(peers.ava.screen.getByRole('status', 'Counter')).toHaveText('2');
  await expect(peers.ava.screen).toHaveScreenshot('counter');
});
`,
    };
    const configSource = counterConfig.replace(
      "targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],",
      "targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }, { name: 'web-b', engine: web(), app: { url: process.env.APP_URL! } }],",
    );
    const { outcome, project } = await runProjectWithConfigFile(files, { appUrl: app.url, configSource });
    try {
      const acts = (run: RunOutcome) =>
        run.results.map((result) => [result.target.name, result.attempts[0]?.steps.find((step) => step.api === 'agent.act')?.cache?.write ?? null]).toSorted();
      // Each pair's peer recorded its own step, and wrote its own missing baseline.
      expect(acts(outcome)).toEqual([
        ['web', 'saved'],
        ['web-b', 'saved'],
      ]);
      expect(calls(project)).toHaveLength(2);
      const snapshots = path.join(project.dir, 'tests', 'pair.e2e.ts-snapshots');
      for (const pairTarget of ['web', 'web-b']) {
        expect(existsSync(path.join(snapshots, 'peers', pairTarget, 'ava', `counter-web-${process.platform}.png`)), pairTarget).toBe(true);
      }
      // The next run replays each pair's own recording and matches each pair's own baseline.
      const second = await runExistingWithConfigFile(project, { appUrl: app.url });
      expect(second.results.map((result) => [result.target.name, result.status]).toSorted()).toEqual([
        ['web', 'passed'],
        ['web-b', 'passed'],
      ]);
      expect(calls(project)).toHaveLength(2);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it("runs a peer's step live under --strict-cache when only the test's own user has a recording of it", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
import { existsSync } from 'node:fs';
const withAva = existsSync(new URL('../with-ava', import.meta.url));
test('strict', { peers: { ava: {} } }, async ({ app, agent, screen, peers }) => {
  await app.open('/');
  await peers.ava.app.open('/');
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status', 'Counter')).toHaveText('2');
  if (!withAva) return;
  await peers.ava.agent.act('increment the counter twice');
  await expect(peers.ava.screen.getByRole('status', 'Counter')).toHaveText('2');
});
`,
      },
      { appUrl: app.url, configSource: counterConfig },
    );
    try {
      const first = onlyAttempt(outcome, 'strict');
      expect(first.result.status, first.why).toBe('passed');
      writeFileSync(path.join(project.dir, 'with-ava'), '');
      const second = await runExistingWithConfigFile(project, { appUrl: app.url, runOptions: { strictCache: true } });
      const again = onlyAttempt(second, 'strict');
      expect(again.result.status, again.why).toBe('passed');
      const acts = again.attempt.steps.filter((step) => step.api === 'agent.act');
      expect(acts.map((step) => [step.user ?? null, step.cache?.mode, step.cache?.reason ?? null])).toEqual([
        [null, 'self-finalized', null],
        ['ava', 'missed', 'no-entry'],
      ]);
      expect(calls(project)).toHaveLength(2);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it("keys a peer's recording on the peer's own target", async () => {
    const twoTargets = counterConfig.replace(
      "targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],",
      "targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }, { name: 'web-b', engine: web(), app: { url: process.env.APP_URL! } }],",
    );
    expect(twoTargets).not.toBe(counterConfig);
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('elsewhere', { platforms: ['web'], peers: { ava: { target: 'web-b' } } }, async ({ app, peers }) => {
  await app.open('/');
  await peers.ava.app.open('/');
  await peers.ava.agent.act('increment the counter twice');
  await expect(peers.ava.screen.getByRole('status', 'Counter')).toHaveText('2');
});
`,
      },
      { appUrl: app.url, configSource: twoTargets },
    );
    try {
      const results = outcome.results.filter((result) => result.test.title === 'elsewhere');
      expect(results.map((result) => result.status)).toEqual(['passed', 'passed']);
      const files = readdirSync(path.join(project.dir, '.e2e', 'cache'), { recursive: true }).filter((file) => String(file).endsWith('.json'));
      const recordedFor = files.map(
        (file) =>
          (JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'cache', String(file)), 'utf8')) as { payload: { recordedFor?: { targetId: string; user?: string; ownerTargetId?: string } } }).payload
            .recordedFor,
      );
      // Both runs of the test have Ava on "web-b": each run's recording is on her target, one for each target the test ran on.
      expect(recordedFor.map((step) => [step?.targetId, step?.user, step?.ownerTargetId]).toSorted()).toEqual([
        ['web-b', 'ava', 'web'],
        ['web-b', 'ava', 'web-b'],
      ]);
    } finally {
      project.cleanup();
    }
  });

  it("confirms, on an attempt that fails, only what each user's own checks verified before the failure", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('fails after my check', { peers: { ava: {}, bob: {} } }, async ({ app, agent, screen, peers }) => {
  await app.open('/');
  await peers.ava.app.open('/');
  await peers.bob.app.open('/');
  await peers.ava.agent.act('increment the counter twice');
  await peers.bob.agent.act('increment the counter twice');
  await expect(peers.bob.screen.getByRole('status', 'Counter')).toHaveText('2');
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status', 'Counter')).toHaveText('2');
  await expect(screen.getByRole('status', 'Counter')).toHaveText('3', { timeout: 300 });
});
`,
      },
      { appUrl: app.url, configSource: counterConfig },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'fails after my check');
      expect(result.status, why).toBe('failed');
      const acts = attempt.steps.filter((step) => step.api === 'agent.act');
      expect(acts.map((step) => [step.user ?? null, step.cache?.write])).toEqual([
        ['ava', 'unconfirmed'],
        ['bob', 'saved'],
        [null, 'saved'],
      ]);
    } finally {
      project.cleanup();
    }
  });

  it("confirms a user's recording only by that user's own later check", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test, expect } from 'e2e';
test('only mine checked', { peers: { ava: {} } }, async ({ app, agent, screen, peers }) => {
  await app.open('/');
  await peers.ava.app.open('/');
  await peers.ava.agent.act('increment the counter twice');
  await agent.act('increment the counter twice');
  await expect(screen.getByRole('status', 'Counter')).toHaveText('2');
});
`,
      },
      { appUrl: app.url, configSource: counterConfig },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'only mine checked');
      expect(result.status, why).toBe('passed');
      const acts = attempt.steps.filter((step) => step.api === 'agent.act');
      expect(acts.map((step) => [step.user ?? null, step.cache?.write])).toEqual([
        ['ava', 'unconfirmed'],
        [null, 'saved'],
      ]);
    } finally {
      project.cleanup();
    }
  });
});

/**
 * A worker-path config on the fake engine whose every load numbers itself:
 * the runner's and the worker's own loads come first, so a peer's engine is
 * a later number. Each engine logs its lifecycle to `events.log`.
 */
function lifecycleConfig(behavior: string): string {
  return `import type { E2EConfig } from 'e2e';
import { appendFileSync } from 'node:fs';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const g = globalThis as { __peerLoads?: number };
const id = (g.__peerLoads = (g.__peerLoads ?? 0) + 1);
const log = (event: string) => appendFileSync(new URL('./events.log', import.meta.url), process.pid + ':' + id + ' ' + event + '\\n');
const engine = createFakeEngine({
  onInit: () => { log('init'); ${behavior.includes('boot') ? "if (id > 1) throw new Error('the peer engine would not boot');" : ''} },
  onStartAttempt: () => { log('start'); ${behavior.includes('start') ? "if (id > 1) throw new Error('the peer app would not open');" : ''} },
  onEndAttempt: () => { log('end'); ${behavior.includes('end') ? "if (id > 1) throw new Error('the peer app would not close');" : ''} },
  ${behavior.includes('settle-every') ? "onSettleAttempt: () => { throw new Error('the ' + (id > 1 ? 'peer' : 'test') + ' app failed after its last step'); }," : behavior.includes('settle') ? "onSettleAttempt: () => { if (id > 1) throw new Error('the peer app failed after its last step'); }," : ''}
  onDispose: () => { log('dispose'); ${behavior.includes('dispose') ? "if (id > 1) throw new Error('the peer engine would not shut down');" : ''} },
}).engine;

export default {
  targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }],
  workers: 1,
} satisfies E2EConfig;
`;
}

/** The lifecycle lines of the worker that ran the tests, with its first engine as `test` and later ones as `peer`. */
function workerEvents(projectDir: string): string[] {
  const lines = readFileSync(path.join(projectDir, 'events.log'), 'utf8').trim().split('\n');
  const worker = lines.find((line) => line.endsWith(' start'))?.split(':')[0];
  const own = lines.filter((line) => line.startsWith(`${worker}:`)).map((line) => line.slice(line.indexOf(':') + 1));
  const first = Math.min(...own.map((line) => Number(line.split(' ')[0])));
  return own.map((line) => {
    const [id, event] = line.split(' ');
    return `${Number(id) === first ? 'test' : 'peer'} ${event}`;
  });
}

describe('peers: engines and lifecycle', () => {
  it("stops the run once when a peer's agent meets a model its provider does not serve, as the test's own agent does", async () => {
    // The same run twice: the test's own agent meets the model, then a peer's agent does.
    const ends = async (options: string, fixture: string, agent: string) => {
      const { outcome, project } = await runProjectWithConfigFile(
        {
          'tests/pair.e2e.ts': `import { test } from 'e2e';
test('first', ${options}, async ({ ${fixture} }) => {
  await ${agent}.act('do the thing');
});
test('second', async () => {});
`,
        },
        {
          configSource: `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
import { refusedCopilotModel } from '../../helpers/unserved-copilot-model.ts';

export default {
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',
  agents: { default: {}, guest: { model: refusedCopilotModel() } },
} satisfies E2EConfig;
`,
        },
      );
      try {
        return {
          exitCode: outcome.exitCode,
          errors: outcome.report.run.errors.map((error) => [error.code, error.message.includes(REFUSAL_EXPLANATION)]),
          results: outcome.report.run.results.map((result) => [result.titlePath.at(-1), result.status, result.attempts.length, result.attempts[0]?.error?.code]),
        };
      } finally {
        project.cleanup();
      }
    };
    const own = await ends("{ agent: 'guest' }", 'agent', 'agent');
    // The run's stop cuts the test short in the worker, so its attempt reads interrupted or the model's code, as other runs of it do.
    expect(own).toEqual({
      exitCode: 2,
      errors: [['MODEL_UNAVAILABLE', true]],
      results: [
        ['first', 'interrupted', 1, expect.stringMatching(/^(INTERRUPTED|MODEL_UNAVAILABLE)$/)],
        ['second', 'skipped', 0, undefined],
      ],
    });
    expect(await ends("{ peers: { ava: { agent: 'guest' } } }", 'peers', 'peers.ava.agent')).toEqual(own);
  });

  it('runs a peer on an engine of its own, opened before the body and closed with the test, then disposed with the worker', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('unused peer', { peers: { ava: {} } }, async () => {});
test('second', { peers: { ava: {} } }, async () => {});
`,
      },
      { configSource: lifecycleConfig('') },
    );
    try {
      expect(onlyAttempt(outcome, 'unused peer').result.status).toBe('passed');
      expect(workerEvents(project.dir)).toEqual([
        'test init', 'test start', 'peer init', 'peer start', 'peer end', 'test end',
        'test start', 'peer start', 'peer end', 'test end',
        'peer dispose', 'test dispose',
      ]);
    } finally {
      project.cleanup();
    }
  });

  it("closes every user's app when the test times out in a peer's step, when the run is interrupted mid-test, and at the run's time limit", async () => {
    // A peer step that never finishes on its own: the fake engine's tap waits on its signal.
    const files = {
      'tests/pair.e2e.ts': `import { test } from 'e2e';
test('slow peer', { peers: { ava: {} }, timeout: 800 }, async ({ peers }) => {
  await peers.ava.screen.getByRole('button', 'Submit').tap();
});
`,
    };
    const hanging = lifecycleConfig('').replace(
      "const engine = createFakeEngine({",
      "const engine = createFakeEngine({\n  perform: (_ref, _action, operation) => new Promise((_resolve, reject) => operation.signal.addEventListener('abort', () => reject(operation.signal.reason), { once: true })),",
    );
    expect(hanging).not.toBe(lifecycleConfig(''));
    const timedOut = await runProjectWithConfigFile(files, { configSource: hanging });
    try {
      const { result, attempt, why } = onlyAttempt(timedOut.outcome, 'slow peer');
      expect(result.status, why).toBe('timed-out');
      expect(attempt.steps.find((step) => step.api === 'locator.tap')).toMatchObject({ user: 'ava' });
      expect(attempt.steps.find((step) => step.api === 'locator.tap')?.status).not.toBe('passed');
      expect(workerEvents(timedOut.project.dir)).toEqual(['test init', 'test start', 'peer init', 'peer start', 'peer end', 'test end', 'peer dispose', 'test dispose']);
    } finally {
      timedOut.project.cleanup();
    }

    // The same test with a long timeout, interrupted once the peer's step is running.
    const interrupt = new AbortController();
    const interrupted = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': files['tests/pair.e2e.ts'].replace('timeout: 800', 'timeout: 60_000') },
      {
        configSource: hanging,
        runOptions: {
          interruptSignal: interrupt.signal,
          onEvent: (event) => {
            if (event.type === 'step' && event.progress.phase === 'start' && event.progress.identity?.user === 'ava') setTimeout(() => interrupt.abort(), 200);
          },
        },
      },
    );
    try {
      const { result, why } = onlyAttempt(interrupted.outcome, 'slow peer');
      expect(result.status, why).toBe('interrupted');
      expect(interrupted.outcome.report.run.status).toBe('interrupted');
      expect(workerEvents(interrupted.project.dir)).toEqual(['test init', 'test start', 'peer init', 'peer start', 'peer end', 'test end', 'peer dispose', 'test dispose']);
    } finally {
      interrupted.project.cleanup();
    }

    // And when the run's time limit lands mid-test.
    const limited = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': files['tests/pair.e2e.ts'].replace('timeout: 800', 'timeout: 60_000') },
      { configSource: hanging, runOptions: { maxDuration: 2_000 } },
    );
    try {
      const { result, why } = onlyAttempt(limited.outcome, 'slow peer');
      expect(result.status, why).toBe('interrupted');
      expect(workerEvents(limited.project.dir)).toEqual(['test init', 'test start', 'peer init', 'peer start', 'peer end', 'test end', 'peer dispose', 'test dispose']);
    } finally {
      limited.project.cleanup();
    }
  }, 180_000);

  it('fails the launch when a peer app cannot open, and closes the test app too', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { configSource: lifecycleConfig('start') },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('failed');
      expect(attempt.error).toMatchObject({ code: 'ENGINE_FAILURE', phase: 'launch' });
      expect(attempt.error?.message).toContain('the peer app would not open');
      expect(workerEvents(project.dir)).toEqual(['test init', 'test start', 'peer init', 'peer start', 'peer end', 'test end', 'peer dispose', 'test dispose']);
    } finally {
      project.cleanup();
    }
  });

  it('keeps a peer engine boot failure for every later test on the worker, as for the test own engine', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('first', { peers: { ava: {} } }, async () => {});
test('second', { peers: { ava: {} } }, async () => {});
`,
      },
      { configSource: lifecycleConfig('boot') },
    );
    try {
      for (const title of ['first', 'second']) {
        const { result, attempt, why } = onlyAttempt(outcome, title);
        expect(result.status, why).toBe('failed');
        expect(attempt.error?.message).toContain('the peer engine would not boot');
      }
      expect(workerEvents(project.dir).filter((event) => event === 'peer init')).toHaveLength(1);
    } finally {
      project.cleanup();
    }
  });

  it('fails the test with a failure a peer app reports after its last step', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { configSource: lifecycleConfig('settle') },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('failed');
      expect(attempt.error?.message).toContain('the peer app failed after its last step');
    } finally {
      project.cleanup();
    }
  });

  it("records every user's failure after the last step, the peer's beside the test's own app's", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { configSource: lifecycleConfig('settle-every') },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('failed');
      // Settled after the body and again after teardown: each time every user is, whichever fails first.
      expect([attempt.error!, ...attempt.secondaryErrors].map((error) => [error.phase, error.message])).toEqual([
        ['body', 'attempt settle failed: the test app failed after its last step'],
        ['body', 'attempt settle failed: the peer app failed after its last step'],
        ['afterEach', 'attempt settle failed: the test app failed after its last step'],
        ['afterEach', 'attempt settle failed: the peer app failed after its last step'],
      ]);
    } finally {
      project.cleanup();
    }
  });

  it("names the peer on a video its engine's host keeps by URL, as on a video file it writes", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('filmed', { peers: { ava: {} }, video: 'on' }, async () => {});\n` },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ video: true, videoLinks: ['https://recordings.example/r.mp4'] }).engine, app: FAKE_APP }],
  workers: 1,
} satisfies E2EConfig;
`,
      },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'filmed');
      expect(result.status, why).toBe('passed');
      const videos = attempt.artifacts.filter((artifact) => artifact.kind === 'video');
      // Each user's engine hands back a link and a file: the peer's two carry its name, the test's own user's neither.
      expect(videos.map((video) => [video.url === undefined ? 'file' : 'link', video.user ?? null]).toSorted()).toEqual([
        ['file', null],
        ['file', 'ava'],
        ['link', null],
        ['link', 'ava'],
      ]);
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('gives a peer its own instance of an engine made in a project file the config imports', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'engines.ts': `import { createFakeEngine } from '../../helpers/fake-engine.ts';\nexport const engine = createFakeEngine().engine;\n`,
        'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { FAKE_APP } from '../../helpers/fake-engine.ts';
import { engine } from './engines.ts';
export default { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }], workers: 1 } satisfies E2EConfig;
`,
      },
    );
    try {
      const { result, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('marks the attempt cleanup failed when a peer app cannot close', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { configSource: lifecycleConfig('end') },
    );
    try {
      const { attempt, why } = onlyAttempt(outcome, 'pair');
      expect(attempt.cleanup, why).toBe('failed');
      expect(attempt.secondaryErrors.map((error) => error.message).join('\n')).toContain('the peer app would not close');
    } finally {
      project.cleanup();
    }
  });

  it('reports a peer engine that cannot shut down as a run error', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { configSource: lifecycleConfig('dispose') },
    );
    try {
      expect(onlyAttempt(outcome, 'pair').result.status).toBe('passed');
      expect(outcome.report.run.errors.map((error) => error.message).join('\n')).toContain('the peer engine would not shut down');
    } finally {
      project.cleanup();
    }
  });

  it('opens fresh apps for both users on every retry', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
import { existsSync, writeFileSync } from 'node:fs';
const flag = new URL('../first-try', import.meta.url);
test('flaky', { peers: { ava: {} }, retries: 1 }, async () => {
  if (!existsSync(flag)) {
    writeFileSync(flag, '');
    throw new Error('first try fails');
  }
});
`,
      },
      { configSource: lifecycleConfig('') },
    );
    try {
      const result = resultByTitle(outcome, 'flaky');
      expect(result.status).toBe('flaky');
      expect(workerEvents(project.dir).filter((event) => event.endsWith(' start'))).toEqual(['test start', 'peer start', 'test start', 'peer start']);
    } finally {
      project.cleanup();
    }
  });

  it('refuses a peer whose target engine comes from a package, the one instance every load shares', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'node_modules/shared-engine/package.json': JSON.stringify({ name: 'shared-engine', type: 'module', exports: './index.js' }),
        'node_modules/shared-engine/index.js': `import { defineEngine } from '${BUILT_ENGINE_API}';
export const engine = defineEngine({ name: 'shared', version: '1.0.0', spiVersion: 1 });
`,
        'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\ntest('second pair', { peers: { ava: {} } }, async () => {});\n`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { engine } from 'shared-engine';
export default { targets: [{ name: 'shared', platform: 'shared', engine, app: { url: 'http://127.0.0.1:4599' } }], workers: 1 } satisfies E2EConfig;
`,
      },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('failed');
      expect(attempt.error).toMatchObject({ code: 'INVALID_CONFIG', phase: 'launch' });
      expect(attempt.error?.message).toContain("whose engine is the same instance as another user's in every load of the config");
      // The second test on the worker meets the same refusal, under its own name.
      const second = onlyAttempt(outcome, 'second pair');
      expect(second.attempt.error?.message, second.why).toContain('test "second pair" in tests/pair.e2e.ts runs a peer');
    } finally {
      project.cleanup();
    }
  });

  it("starts the app of a peer's target that runs no test of its own, on the port the run chose", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'other-app.mjs': `import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync(new URL('./started.log', import.meta.url), process.env.PORT + '\\n');
createServer((_request, response) => response.end('other')).listen(Number(process.env.PORT), '127.0.0.1');
`,
        'tests/pair.e2e.ts': `import { test } from 'e2e';
import { readFileSync } from 'node:fs';
test('pair', { requires: ['state'], peers: { ava: { target: 'other' } } }, async ({ peers }) => {
  // The run started the other target's app on a free port, and the peer's engine reads the same port.
  const started = readFileSync(new URL('../started.log', import.meta.url), 'utf8').trim();
  if (!peers.ava.app.baseUrl.endsWith(':' + started)) throw new Error('the peer app is at ' + peers.ava.app.baseUrl + ', its command on ' + started);
});
`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  targets: [
    { name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
    // No saved state: the test requires it, so this target runs none of its own.
    {
      name: 'other',
      platform: 'other',
      engine: createFakeEngine().engine,
      app: { url: 'http://127.0.0.1:0', command: { executable: process.execPath, args: ['other-app.mjs'], env: { PORT: '{port}' } } },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
`,
      },
    );
    try {
      const results = outcome.results.filter((result) => result.test.title === 'pair');
      expect(results.map((result) => [result.target.name, result.status]).toSorted()).toEqual([
        ['fake', 'passed'],
        ['other', 'skipped'],
      ]);
      const onFake = results.find((result) => result.target.name === 'fake')!;
      expect(onFake.attempts[0]?.error, JSON.stringify(onFake.attempts[0]?.error)).toBeUndefined();
    } finally {
      project.cleanup();
    }
  });

  it("hands each user's agent the tools of that user's own config load, so a tool reaches its own user's engine", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('pair', { peers: { ava: {}, bob: {} } }, async ({ agent, peers }) => {
  await peers.ava.agent.act('say who you are');
  await agent.act('say who you are');
  await peers.bob.agent.act('say who you are');
});
`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { defineTool } from 'e2e/agent';
import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
import { installFakeLoopModel } from '../../helpers/fake-loop-model.ts';

// Every load of the config numbers itself, and builds an engine and a tool that knows which engine is its own.
const g = globalThis as { __toolLoads?: number };
const load = (g.__toolLoads = (g.__toolLoads ?? 0) + 1);
let running = false;
const engine = createFakeEngine({
  onStartAttempt: () => { running = true; },
  onEndAttempt: () => { running = false; },
}).engine;
const whoami = defineTool(
  {
    description: 'Says which load of the config built this tool, and whether its engine has an attempt running',
    inputSchema: z.object({}),
    execute: async () => {
      appendFileSync(new URL('./tools.log', import.meta.url), process.pid + ' load ' + load + ' running ' + running + '\\n');
      return 'load ' + load;
    },
  },
  { mutates: false },
);
const model = installFakeLoopModel((call) =>
  call.lastToolResult.startsWith('load ')
    ? [{ toolName: 'complete_step', input: { status: 'passed', summary: call.lastToolResult } }]
    : [{ toolName: 'whoami', input: {} }],
);

export default {
  targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',
  agents: { default: { model, tools: { whoami } } },
} satisfies E2EConfig;
`,
      },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('passed');
      const calls = readFileSync(path.join(project.dir, 'tools.log'), 'utf8').trim().split('\n').map((line) => line.split(' '));
      // One worker made every call; each came from a different load, whose own engine was running.
      expect(new Set(calls.map(([pid]) => pid)).size).toBe(1);
      expect(calls.map((call) => call.slice(3).join(' '))).toEqual(['running true', 'running true', 'running true']);
      const loads = calls.map((call) => call[2]);
      expect(new Set(loads).size).toBe(3);
      // The step's own summary is what its own tool answered.
      const acts = attempt.steps.filter((step) => step.api === 'agent.act');
      expect(acts.map((step) => step.user ?? null)).toEqual(['ava', null, 'bob']);
      expect(acts.map((step) => step.explanation)).toEqual(loads.map((load) => `load ${load}`));
    } finally {
      project.cleanup();
    }
  });

  it("gives the test's own inconclusive judgment the vision hint of its own steps, not a peer's", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('pair', { peers: { ava: {} } }, async ({ agent, peers }) => {
  await peers.ava.agent.assert('the invite is on screen', { vision: true });
  await agent.assert('the order total is shown');
});
test('peer', { peers: { ava: {} } }, async ({ peers }) => {
  await peers.ava.agent.assert('the invite is on screen', { vision: true });
  await peers.ava.agent.assert('the order total is shown');
});
`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
import { installFakeModel, judgment } from '../../helpers/fake-model.ts';

const engine = createFakeEngine({
  artifacts: true,
  pixels: (options) => (options.pixels === true ? { pixels: { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 2, height: 2, scale: 1 } } : undefined),
}).engine;
const model = installFakeModel((call) => (call.instruction === 'the invite is on screen' ? judgment(true, 'the invite is shown') : judgment('inconclusive', 'no order total is on this screen')));

export default {
  targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',
  agents: { default: { model } },
} satisfies E2EConfig;
`,
      },
    );
    try {
      const { result, attempt, why } = onlyAttempt(outcome, 'pair');
      expect(result.status, why).toBe('failed');
      // Ava's judgment saw pixels; the test's own user's steps never did.
      expect(attempt.steps.find((step) => step.user === 'ava')?.visionInput).toBe(true);
      expect(attempt.error?.code).toBe('ASSERTION_INCONCLUSIVE');
      expect(attempt.error?.message).toContain('the judge saw the semantic tree only; if the engine captures pixels, pass vision: true when the answer is in pixels');
      // Ava's own judgment after her own pixels names vision outright.
      const peer = onlyAttempt(outcome, 'peer');
      expect(peer.attempt.error?.code, peer.why).toBe('ASSERTION_INCONCLUSIVE');
      expect(peer.attempt.error?.message).toContain('no order total is on this screen; the judge saw the semantic tree only; pass vision: true when the answer is in pixels');
    } finally {
      project.cleanup();
    }
  });

  it("names each peer's model calls in the AI trace with the agent the peer runs as and its app's target", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('pair', { platforms: ['fake'], agent: 'admin', peers: { ava: { agent: 'guest', target: 'phone' } } }, async ({ agent, peers }) => {
  await agent.act('send the invite');
  await peers.ava.agent.act('accept the invite');
});
`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
import { installFakeLoopModel } from '../../helpers/fake-loop-model.ts';

const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }]);

export default {
  targets: [
    { name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP },
    { name: 'phone', platform: 'phone', engine: createFakeEngine().engine, app: FAKE_APP },
  ],
  workers: 1,
  cache: 'off',
  agents: { default: { model }, admin: { model }, guest: { model } },
} satisfies E2EConfig;
`,
        runOptions: { aiTrace: true },
      },
    );
    try {
      const result = outcome.results.find((entry) => entry.test.title === 'pair' && entry.target.name === 'fake')!;
      expect(result.status, JSON.stringify(result.attempts.map((attempt) => attempt.error))).toBe('passed');
      const trace = JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'ai-trace.json'), 'utf8')) as {
        runs: { function_id: string; e2e?: Record<string, unknown> }[];
      };
      expect(trace.runs.map((run) => [run.function_id, run.e2e?.['agent'], run.e2e?.['target'], run.e2e?.['userAgent'] ?? null, run.e2e?.['userTarget'] ?? null])).toEqual([
        ['pair · as admin · agent.act "send the invite"', 'admin', 'fake', null, null],
        ['pair · as admin · peer ava as guest · agent.act "accept the invite"', 'admin', 'fake', 'guest', 'phone'],
      ]);
    } finally {
      project.cleanup();
    }
  });

  it('refuses a second user on an engine object another user in the worker already runs on, whichever target names it', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/pair.e2e.ts': `import { test } from 'e2e';
test('two targets', { platforms: ['fake'], peers: { ava: { target: 'left' }, bob: { target: 'right' } } }, async () => {});
test('one target', { platforms: ['fake'], peers: { ava: { target: 'left' }, bob: { target: 'left' } } }, async () => {});
test('apart', { platforms: ['fake'], peers: { ava: { target: 'left' } } }, async () => {});
`,
      },
      {
        configSource: `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

// One engine object every load of the config shares, as one made inside a package is.
const g = globalThis as { __shared?: ReturnType<typeof createFakeEngine>['engine'] };
const shared = (g.__shared ??= createFakeEngine({ state: true }).engine);

export default {
  targets: [
    { name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP },
    { name: 'left', platform: 'shared', engine: shared, app: FAKE_APP },
    { name: 'right', platform: 'shared', engine: shared, app: FAKE_APP },
  ],
  workers: 1,
} satisfies E2EConfig;
`,
      },
    );
    try {
      const onFake = (title: string) => {
        const result = outcome.results.find((candidate) => candidate.test.title === title && candidate.target.name === 'fake')!;
        return { result, attempt: result.attempts[0]!, why: JSON.stringify(result.attempts.map((each) => each.error)) };
      };
      for (const [title, target] of [['two targets', 'right'], ['one target', 'left']] as const) {
        const { result, attempt, why } = onFake(title);
        expect(result.status, why).toBe('failed');
        expect(attempt.error).toMatchObject({ code: 'INVALID_CONFIG', phase: 'launch' });
        expect(attempt.error?.message).toContain(`runs a peer on target "${target}", whose engine is the same instance as another user's`);
      }
      // A worker runs one test at a time: the next test's peer takes the engine again.
      const apart = onFake('apart');
      expect(apart.result.status, apart.why).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('refuses peers in a run that loaded no config file before any engine prepares, which has nowhere to load a second engine from', async () => {
    const prepared: (number | null)[] = [];
    const engine = createFakeEngine({ state: true, prepare: (info) => void prepared.push(info.peerSlots ?? null) }).engine;
    const { outcome, project } = await runProject(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} } }, async () => {});\n` },
      { config: { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }] } },
    );
    try {
      expect(outcome.exitCode).toBe(2);
      expect(outcome.results.filter((result) => result.attempts.length > 0)).toEqual([]);
      expect(outcome.report.run.errors.map((error) => [error.code, error.phase, error.message])).toEqual([
        [
          'UNSUPPORTED_CAPABILITY',
          'collection',
          'test "pair" in tests/pair.e2e.ts declares peers, which need a run from a config file: a run given a config value, or of tests registered in memory, has no file to load a second engine from',
        ],
      ]);
      // No engine set a slot aside, or booted a device, for a peer that never runs.
      expect(prepared).toEqual([]);
    } finally {
      project.cleanup();
    }
    // A test with peers that does not run leaves the run alone.
    const skipped = await runProject(
      { 'tests/pair.e2e.ts': `import { test } from 'e2e';\ntest('pair', { peers: { ava: {} }, skip: true }, async () => {});\ntest('alone', async () => {});\n` },
      { config: { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }] } },
    );
    try {
      expect(skipped.outcome.report.run.errors).toEqual([]);
      expect(skipped.outcome.results.map((result) => [result.test.title, result.status]).toSorted()).toEqual([
        ['alone', 'passed'],
        ['pair', 'skipped'],
      ]);
    } finally {
      skipped.project.cleanup();
    }
  });
});
