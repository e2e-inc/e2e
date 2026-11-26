/**
 * What the runner refuses about an actor before anything runs, each as one
 * collection error that names the actor and what to change, and how an
 * actor's saved session decides which setup tests run and what a failed
 * one skips.
 */

import { describe, expect, it } from 'vitest';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

type Targets = NonNullable<E2EConfig['targets']>;

const IMPORTS = `import { test as base } from 'e2e';
import { fakeActor as actor } from '../../../helpers/fake-engine.ts';
import { defineActor } from '../../../helpers/engine-runtime.ts';
`;

const SETUP = `import { test } from 'e2e';
test.setup('sign in as reviewer', { sessions: ['reviewer'] }, async ({ app, session }) => {
  await app.open('/login');
  if (process.env.ACTORS_SETUP_FAILS === '1') throw new Error('the login failed');
  await session.save('reviewer');
});
`;

/** The `fake` target with every capability an actor can need, and a `phone` target beside it. */
const targets = (own: Parameters<typeof createFakeEngine>[0] = {}): Targets => [
  { name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true, actors: true, ...own }).engine, app: FAKE_APP },
  { name: 'phone', platform: 'phone', engine: createFakeEngine({ name: 'phone-engine' }).engine, app: FAKE_APP },
];

/** Runs one test file on the `fake` target and returns the run's errors and results. */
async function run(source: string, options: { readonly targets?: Targets; readonly files?: Readonly<Record<string, string>>; readonly env?: Readonly<Record<string, string>> } = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, options.env);
  const { outcome, project } = await runProject(
    { 'tests/auth.setup.e2e.ts': SETUP, 'tests/a.e2e.ts': `${IMPORTS}${source}`, ...options.files },
    { config: { targets: options.targets ?? targets() }, runOptions: { targetIds: ['fake'] } },
  );
  process.env = previous;
  project.cleanup();
  return { outcome, errors: outcome.report.run.errors.map(({ code, message }) => `${code}: ${message}`) };
}

const one = (fixtures: string, body = 'async ({ who }) => { await who.app.open(); }'): string => `const test = base.extend(${fixtures});\ntest('uses the actor', ${body});\n`;

describe('an actor the runner refuses before the run', { timeout: 120_000 }, () => {
  it.each([
    [
      'a target the config does not have',
      one(`{ who: actor({ target: 'phon' }) }`),
      /^COLLECTION_ERROR: tests\/a\.e2e\.ts:\d+: actor "who" names target "phon", and the config has no target of that name; it has fake, phone; did you mean "phone"\?$/,
    ],
    [
      'an actor of another engine than the test\'s target runs',
      one(`{ who: defineActor('phone-engine')() }`),
      /^COLLECTION_ERROR: tests\/a\.e2e\.ts:\d+: actor "who" is a phone-engine actor, and the test's target "fake" runs engine fake: name the phone-engine target it runs on, as in actor\(\{ target: '\.\.\.' \}\)$/,
    ],
    [
      'an actor of another engine than the target it names runs',
      one(`{ who: actor({ target: 'phone' }) }`),
      /^COLLECTION_ERROR: tests\/a\.e2e\.ts:\d+: actor "who" is a fake actor, and target "phone", which it names, runs engine phone-engine: use the actor\(\) of that engine's package$/,
    ],
    [
      'a saved session on an engine that restores none',
      one(`{ who: defineActor('phone-engine')({ target: 'phone', session: 'reviewer' }) }`),
      /^COLLECTION_ERROR: tests\/a\.e2e\.ts:\d+: actor "who" restores session "reviewer", and target "phone" cannot restore one: engine phone-engine, as configured, has no state capability$/,
    ],
    [
      'a session no setup test saves',
      one(`{ who: actor({ session: 'nobody' }) }`),
      /^COLLECTION_ERROR: test "uses the actor" in tests\/a\.e2e\.ts names actor "who", which restores session "nobody" but no setup test produces it; setup tests declare "reviewer"$/,
    ],
    [
      'a worker-scoped actor',
      one(`{ who: [actor(), { scope: 'worker' }] }`),
      /COLLECTION_ERROR: .*actor "who" cannot be a worker fixture: an actor is opened for one test and closed with it/,
    ],
    [
      'an actor named like a built-in fixture',
      `const test = base.extend({ screen: actor() });\ntest('uses the actor', async ({ screen }) => { await screen.app.open(); });\n`,
      /COLLECTION_ERROR: .*actor "screen" has the name of a built-in fixture/,
    ],
    [
      'an option actor() does not take',
      one(`{ who: actor({ sesion: 'reviewer' }) }`),
      /COLLECTION_ERROR: .*actor\(\) has unknown key "sesion".*session/,
    ],
    [
      'an actor in a suite hook',
      `const test = base.extend({ who: actor() });\ntest.beforeAll(async ({ who }) => { await who.app.open(); });\ntest('runs after the hook', async () => {});\n`,
      /COLLECTION_ERROR: .*beforeAll hook names "who", a test fixture/,
    ],
    [
      'two actors on a target whose engine drives one session at a time',
      `const phone = defineActor('phone-engine');\nconst test = base.extend({ first: phone({ target: 'phone' }), second: phone({ target: 'phone' }) });\ntest('uses both', async ({ first, second }) => { await first.app.open(); await second.app.open(); });\n`,
      /^COLLECTION_ERROR: tests\/a\.e2e\.ts:\d+: actors "first" and "second" both run on target "phone", and engine phone-engine, as configured, drives one session at a time: give each a target of its own$/,
    ],
    [
      'an actor in a serial group',
      `const test = base.extend({ who: actor() });\ntest.describe('steps', { serial: true }, () => {\n  test('first', async ({ who }) => { await who.app.open(); });\n  test('second', async () => {});\n});\n`,
      /^COLLECTION_ERROR: tests\/a\.e2e\.ts:\d+: test "steps > first" is in a serial group and names actor "who": the group's tests share one session, and an actor is opened for one test$/,
    ],
  ])('%s', async (_name, source, message) => {
    const { errors, outcome } = await run(source);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(message);
    // Refused before the run: nothing started.
    expect(outcome.results.filter((result) => result.attempts.length > 0)).toEqual([]);
  });

  it('refuses an actor on the test\'s own target when its engine runs one session at a time', async () => {
    const { errors } = await run(one(`{ who: actor() }`), { targets: targets({ actors: false }) });
    expect(errors).toEqual([
      expect.stringMatching(
        /^COLLECTION_ERROR: tests\/a\.e2e\.ts:\d+: actor "who" runs on the test's own target "fake", and engine fake, as configured, drives one session at a time there: name another target of the config for it, as in actor\(\{ target: '\.\.\.' \}\)$/,
      ),
    ]);
  });

  it('refuses an actor on a target that shares its engine instance with another target', async () => {
    const shared = createFakeEngine({ state: true, actors: true }).engine;
    const { errors } = await run(one(`{ who: actor({ target: 'twin' }) }`), {
      targets: [
        { name: 'fake', platform: 'fake', engine: shared, app: FAKE_APP },
        { name: 'twin', platform: 'fake', engine: shared, app: FAKE_APP },
      ],
    });
    expect(errors).toEqual([
      expect.stringMatching(
        /^COLLECTION_ERROR: tests\/a\.e2e\.ts:\d+: actor "who" runs on target "twin", which shares its engine instance with target "fake": give the target an engine of its own, a second fake\(\) call in the config$/,
      ),
    ]);
  });

  it.each(['launch-1', '../up', 'a/b', 'with space'])('refuses an actor named %j: the name labels its steps and names its files', async (name) => {
    const { errors } = await run(`const test = base.extend({ ${JSON.stringify(name)}: actor() });\ntest('uses the actor', async ({ ${JSON.stringify(name)}: who }) => { await who.app.open(); });\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`actor ${JSON.stringify(name)} must be named with letters, digits, and _ only, starting with a letter`);
  });

  it('refuses a setup test whose actor starts from a saved session', async () => {
    const setup = `${IMPORTS}const test = base.extend({ who: actor({ session: 'reviewer' }) });
test.setup('sign in as author', { sessions: ['author'] }, async ({ app, session, who }) => {
  await app.open('/login');
  await session.save('author');
});
`;
    const { errors } = await run(`base('starts as the author', { session: 'author' }, async ({ app }) => { await app.open(); });\n`, { files: { 'tests/author.setup.e2e.ts': setup } });
    expect(errors).toEqual([
      expect.stringMatching(/COLLECTION_ERROR: .*setup test "sign in as author" names actor "who", which restores session "reviewer": a setup test cannot start from a session another one saves$/),
    ]);
  });

  it('leaves an actor it could not open alone on a target the test does not run on', async () => {
    // The actor names a target the config lacks, and the only test that names it is for another platform.
    const { errors, outcome } = await run(
      `const test = base.extend({ who: actor({ target: 'tablet' }) });
test('runs on a tablet target only', { platforms: ['tablet'] }, async ({ who }) => { await who.app.open(); });
test('runs here', async ({ app }) => { await app.open(); });
`,
    );
    expect(errors).toEqual([]);
    expect(resultByTitle(outcome, 'runs here').status).toBe('passed');
  });
});

describe('a target only an actor runs on', { timeout: 120_000 }, () => {
  it('has its app started for the actor of a setup test, though nothing selected the target', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const serve = `require('node:http').createServer((request, response) => response.end('helper app')).listen(${port}, '127.0.0.1')`;
    const setup = `${IMPORTS}const test = base.extend({ helper: defineActor('phone-engine')({ target: 'phone' }) });
test.setup('sign in with a helper', { sessions: ['author'] }, async ({ app, session, helper }) => {
  await app.open('/login');
  await helper.app.open();
  globalThis.actorsHelperApp = await fetch(${JSON.stringify(url)}).then((response) => response.text(), (cause) => String(cause));
  await session.save('author');
});
`;
    const { errors, outcome } = await run(`base('starts as the author', { session: 'author' }, async ({ app }) => { await app.open(); });\n`, {
      files: { 'tests/author.setup.e2e.ts': setup },
      targets: [
        targets()[0]!,
        { name: 'phone', platform: 'phone', engine: createFakeEngine({ name: 'phone-engine' }).engine, app: { url, command: { executable: process.execPath, args: ['-e', serve] } } },
      ],
    });
    expect(errors).toEqual([]);
    expect(resultByTitle(outcome, 'sign in with a helper').status).toBe('passed');
    expect((globalThis as { actorsHelperApp?: string }).actorsHelperApp).toBe('helper app');
    expect(resultByTitle(outcome, 'starts as the author').status).toBe('passed');
  });
});

describe('the setup test behind an actor\'s session', { timeout: 120_000 }, () => {
  const SUITE = `const test = base.extend({ who: actor({ session: 'reviewer' }) });
test('names the actor', async ({ who }) => { await who.app.open(); });
test('names no actor', async ({ app }) => { await app.open(); });
`;

  it('runs for a test that names the actor, and not for a run where none does', async () => {
    const named = await run(SUITE);
    expect(named.errors).toEqual([]);
    expect(resultByTitle(named.outcome, 'sign in as reviewer').status).toBe('passed');
    expect(resultByTitle(named.outcome, 'names the actor').status).toBe('passed');

    const unnamed = await run(`const test = base.extend({ who: actor({ session: 'reviewer' }) });\ntest('names no actor', async ({ app }) => { await app.open(); });\n`);
    expect(unnamed.errors).toEqual([]);
    expect(unnamed.outcome.results.find((result) => result.test.title === 'sign in as reviewer')?.attempts ?? []).toEqual([]);
  });

  it('skips the test that names the actor when the setup fails, and runs the rest', async () => {
    const { outcome } = await run(SUITE, { env: { ACTORS_SETUP_FAILS: '1' } });
    expect(resultByTitle(outcome, 'sign in as reviewer').status).toBe('failed');
    expect(resultByTitle(outcome, 'names the actor')).toMatchObject({ status: 'skipped', skip: { cause: 'setup-failed', reason: 'setup for session "reviewer" failed' } });
    expect(resultByTitle(outcome, 'names no actor').status).toBe('passed');
  });
});
