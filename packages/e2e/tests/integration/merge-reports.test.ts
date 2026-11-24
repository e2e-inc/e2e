import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { resultSegment } from '@e2e-dev/core/lib/run/artifacts';
import type { Report1Document } from '../../src/report/build.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const fixture of projects.splice(0)) fixture.cleanup();
});

function project() {
  const fixture = createProject({
    'e2e.config.ts': `import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
export default {
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }],
  workers: 1, cache: 'off',
  reporters: ['markdown', { name: 'finished', onRunFinished(run) {
    console.log('finished report:', run.report.run.summary.selected);
  } }],
};`,
    'tests/shop.e2e.ts': `import { test } from 'e2e';
test.setup('sign in', { sessions: ['member'] }, async ({ app, session }) => {
  await app.open();
  if (process.env.FAIL_SETUP) throw new Error('sign in failed');
  await session.save('member');
});
test('cart', { session: 'member' }, async ({ app }) => { await app.open(); });
test('checkout', { session: 'member' }, async ({ app }) => {
  await app.open();
  if (process.env.FAIL_CHECKOUT) throw new Error('checkout failed');
});`,
  });
  projects.push(fixture);
  return fixture;
}

function cli(fixture: FixtureProject, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixture.dir,
    env: { ...process.env, CI: '', E2E_TELEMETRY_DISABLED: '1', FAIL_SETUP: '', FAIL_CHECKOUT: '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function report(fixture: FixtureProject, output: string) {
  const document: unknown = JSON.parse(readFileSync(path.join(fixture.dir, output, 'report.json'), 'utf8'));
  assertValidReport(document);
  return (document as Report1Document).run;
}

function shard(fixture: FixtureProject, index: number, env: NodeJS.ProcessEnv = {}) {
  return cli(fixture, ['run', '--shard', `${index}/2`, '--output', `shard-${index}`, '--repeat-each', '2', '--trace', 'on'], env);
}

it('merges real shard runs and uses the merged report for a whole-run rerun', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2, { FAIL_CHECKOUT: '1' }).status).toBe(1);
  const merged = cli(fixture, ['merge-reports', 'shard-2', 'shard-1', '--output', 'merged', '--reporter', 'junit']);
  expect(merged.status, merged.stderr).toBe(1);
  expect(merged.stdout).toContain('finished report: 5');
  expect(existsSync(path.join(fixture.dir, 'merged/junit.xml'))).toBe(true);
  expect(existsSync(path.join(fixture.dir, 'merged/summary.md'))).toBe(false);
  const run = report(fixture, 'merged');
  expect(run.shard).toBeUndefined();
  expect(run.summary).toMatchObject({ passed: 3, failed: 2, flaky: 0 });
  expect(run.results.filter((row) => row.kind === 'setup')).toHaveLength(1);
  const rerun = cli(fixture, ['run', '--last-failed', '--output', 'merged']);
  expect(rerun.status, rerun.stderr).toBe(0);
  expect(report(fixture, 'merged').results.filter((row) => row.selected).map((row) => row.titlePath.at(-1)).toSorted()).toEqual(['checkout', 'sign in']);
}, 60_000);

it('keeps both shared setup executions and links each shard’s local evidence', () => {
  const fixture = project();
  expect(shard(fixture, 1, { FAIL_SETUP: '1' }).status).toBe(1);
  expect(shard(fixture, 2).status).toBe(0);
  const artifactPath = 'shared/setup.log';
  for (const index of [1, 2]) {
    const directory = path.join(fixture.dir, `shard-${index}`);
    const run = report(fixture, `shard-${index}`);
    const setup = run.results.find((row) => row.kind === 'setup' && row.selected)!;
    const attempt = setup.attempts[0]!;
    const content = `login in shard ${index}`;
    attempt.artifacts = [...attempt.artifacts, {
      id: 'sign-in-log', kind: 'log', mediaType: 'text/plain', redaction: 'complete',
      producer: { kind: 'attempt' }, path: artifactPath,
      size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
    }];
    mkdirSync(path.join(directory, 'results/shared'), { recursive: true });
    writeFileSync(path.join(directory, 'results', artifactPath), content);
    if (index === 2) run.project.configDigest = 'f'.repeat(64);
    assertValidReport({ schemaVersion: 'report-1', run });
    writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ schemaVersion: 'report-1', run }));
  }
  const merged = cli(fixture, ['merge-reports', 'shard-2', 'shard-1', '--output', 'merged', '--reporter', 'json']);
  expect(merged.status, merged.stderr).toBe(1);
  expect(merged.stderr).toContain('shard 2 has a different config digest');
  // Configured reporters may write, while stdout still contains just JSON.
  const run = report(fixture, 'merged');
  expect(JSON.parse(merged.stdout).run.id).toBe(run.id);
  const setups = run.results.filter((row) => row.kind === 'setup');
  expect(setups).toHaveLength(1);
  expect(setups[0]?.status).toBe('failed');
  expect(setups[0]?.attempts.map((attempt) => [attempt.shard, attempt.status])).toEqual([[1, 'failed'], [2, 'passed']]);
  const root = path.join(fixture.dir, 'merged/results');
  const trace = readFileSync(path.join(root, resultSegment(setups[0]!), 'trace.md'), 'utf8');
  for (const index of [1, 2]) {
    expect(trace).toContain(`../shard-${index}/${artifactPath}`);
    expect(readFileSync(path.join(root, `shard-${index}`, artifactPath), 'utf8')).toBe(`login in shard ${index}`);
  }
  // A rerun plus the merged directory alone must keep the old evidence.
  expect(cli(fixture, ['run', '--last-failed', '--output', 'merged']).status).toBe(0);
  for (const index of [1, 2]) expect(existsSync(path.join(root, `shard-${index}`, artifactPath))).toBe(true);
}, 60_000);

it('prefers a shard’s folded rerun and preserves results owned by the other shard', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2, { FAIL_CHECKOUT: '1' }).status).toBe(1);
  expect(cli(fixture, ['run', '--last-failed', '--output', 'shard-2']).status).toBe(0);
  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged']);
  expect(merged.status, merged.stderr).toBe(0);
  expect(report(fixture, 'merged').results.filter((row) => row.selected && row.kind === 'test').map((row) => [
    row.titlePath.at(-1), row.repeat, row.status, row.attempts.length,
  ])).toEqual([['cart', 0, 'passed', 1], ['cart', 1, 'passed', 1], ['checkout', 0, 'flaky', 3]]);
}, 60_000);

it('refuses a live-only reporter and refuses artifacts that resolve outside a shard', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  writeFileSync(path.join(fixture.dir, 'live.config.mjs'), 'export default { reporters: [{ name: "live", onEvent() {} }] };');
  const args = ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged'];
  const live = cli(fixture, [...args, '--config', 'live.config.mjs']);
  expect(live.status).toBe(2);
  expect(live.stderr).toContain('reporter "live" needs live events');
  const run = report(fixture, 'shard-1');
  const attempt = run.results.find((row) => row.selected)!.attempts[0]!;
  attempt.artifacts = [...attempt.artifacts, { id: 'external', kind: 'log', mediaType: 'text/plain', redaction: 'complete', producer: { kind: 'attempt' }, path: 'external.log' }];
  const directory = path.join(fixture.dir, 'shard-1');
  symlinkSync(path.join(fixture.dir, 'e2e.config.ts'), path.join(directory, 'results', 'external.log'));
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ schemaVersion: 'report-1', run }));
  const malformedArtifact = cli(fixture, args);
  expect(malformedArtifact.status).toBe(2);
  expect(malformedArtifact.stderr).toContain('must be a file inside its results directory');
  expect(existsSync(path.join(fixture.dir, 'merged'))).toBe(false);
  expect(readdirSync(fixture.dir).some((entry) => entry.startsWith('.e2e-merge-'))).toBe(false);
}, 60_000);

it('redacts a merge config secret in config output and reporter errors', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const value = 'fake-merge-secret-89617+case';
  writeFileSync(path.join(fixture.dir, 'publish.config.mjs'), `
const value = process.env.MERGE_FIXTURE_SECRET;
console.log(value);
export default { secrets: { publishing: value }, reporters: [{
  name: 'publisher', onRunFinished() { throw new Error(value); },
}] };
`);
  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged', '--config', 'publish.config.mjs'], {
    MERGE_FIXTURE_SECRET: value,
  });
  expect(merged.status).toBe(0);
  expect(merged.stderr).toContain('reporter "publisher" failed: <secret:publishing>');
  for (const representation of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) {
    expect((merged.stdout + merged.stderr).includes(representation)).toBe(false);
    expect(readFileSync(path.join(fixture.dir, 'merged/report.json'), 'utf8').includes(representation)).toBe(false);
  }
}, 60_000);

it('identifies missing and duplicate shards before writing any report', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  const missing = cli(fixture, ['merge-reports', 'shard-1', '--output', 'merged']);
  expect(missing.status, missing.stderr).toBe(2);
  expect(missing.stderr).toContain('missing shard 2');
  const duplicate = cli(fixture, ['merge-reports', 'shard-1', 'shard-1', '--output', 'merged']);
  expect(duplicate.status).toBe(2);
  expect(duplicate.stderr).toContain('duplicate shard 1');
  expect(existsSync(path.join(fixture.dir, 'merged'))).toBe(false);
}, 60_000);
