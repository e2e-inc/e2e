/** Dot progress and user output keep their own formatting through the built CLI. */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuiltinReporter } from '../../src/run-types.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** Runs one passing test and optionally writes user output after the final dot. */
function runReporters(reporters: readonly BuiltinReporter[], outputAtEnd = '') {
  const project = createProject({
    'e2e.config.ts': `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({}).engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',
  reporters: [
    ...${JSON.stringify(reporters)},
    {
      name: 'user-output',
      onEvent(event) {
        if (event.type === 'run-finished') { ${outputAtEnd} }
      },
    },
  ],
} satisfies E2EConfig;
`,
    'tests/pass.e2e.ts': `import { test } from 'e2e';
test('passes', async ({ app }) => { await app.open(); });
`,
  });
  projects.push(project);
  const result = spawnSync(process.execPath, [CLI, 'run'], {
    cwd: project.dir,
    env: { ...process.env, CI: '', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return { stdout: result.stdout, stderr: result.stderr };
}

describe('dot reporter output at the CLI boundary', () => {
  it.each(['stdout', 'stderr'] as const)('ends unfinished user %s on its own line', (stream) => {
    const result = runReporters(['dot'], `process.${stream}.write('tail');`);
    expect(result.stdout).toBe(stream === 'stdout' ? '.\ntail\n' : '.\n');
    expect(result.stderr).toBe(stream === 'stderr' ? 'tail\n' : '');
  });

  it('ends unfinished user output on both destinations', () => {
    const result = runReporters(['dot'], `process.stdout.write('stdout tail'); process.stderr.write('stderr tail');`);
    expect(result.stdout).toBe('.\nstdout tail\n');
    expect(result.stderr).toBe('stderr tail\n');
  });

  it('ends user output on stderr while keeping JSON stdout valid', () => {
    const result = runReporters(['dot', 'json'], `process.stdout.write('stdout tail'); process.stderr.write('stderr tail');`);
    assertValidReport(JSON.parse(result.stdout));
    expect(result.stderr).toBe('.\nstdout tailstderr tail\n');
  });

  it('does not label dot marks as runner output when combined with list', () => {
    const result = runReporters(['list', 'dot']);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain('stdout | runner');
    expect(output).not.toContain('stderr | runner');
    expect(output).toMatch(/^\.$/m);
  });

  it('keeps list formatting for genuine user output without labelling dot marks', () => {
    const result = runReporters(['list', 'dot'], `process.stdout.write('runner log\\n');`);
    const output = result.stdout + result.stderr;
    expect(output).toContain('stdout | runner\nrunner log\n');
    expect(output.match(/stdout \| runner/g)).toHaveLength(1);
    expect(output).not.toContain('stderr | runner');
  });
});
