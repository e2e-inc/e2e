/**
 * Edge cases of `testInfo` and annotations: a body left running past its
 * timeout, serial members' `outputDir`, a test declared in an imported
 * module, a worker that dies mid-test, and two programmatic runs at once.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject, runProjectWithConfigFile, workerFakeConfigSource } from '../helpers/run-project.ts';

describe('testInfo edge cases', () => {
  it('refuses test.info() from a body past its timeout instead of handing it the next test', async () => {
    const { engine } = createFakeEngine();
    const { outcome, project } = await runProject(
      {
        'tests/late.e2e.ts': `import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'e2e';

// A timeout discards the file's realm, so the gate lives on globalThis for 'second' to open.
globalThis.__gate ??= (() => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
})();
let root;

test('first', { timeout: 300 }, async ({}, testInfo) => {
  root = testInfo.config.projectRoot;
  await globalThis.__gate.promise;
  try {
    test.info().annotations.push({ type: 'leaked-from', description: 'first' });
    writeFileSync(path.join(root, 'late.txt'), 'leaked');
  } catch (error) {
    writeFileSync(path.join(root, 'late.txt'), error.code);
  }
});

test('second', async () => {
  globalThis.__gate.release();
  await new Promise((resolve) => setTimeout(resolve, 200));
});
`,
      },
      { config: engineConfig(engine, { retries: 0 }) },
    );
    try {
      assertValidReport(outcome.report);
      const byTitle = (title: string) => outcome.report.run.results.find((result) => result.titlePath.at(-1) === title)!;
      expect(byTitle('first').status).toBe('timed-out');
      expect(byTitle('second').status).toBe('passed');
      expect(byTitle('second').annotations).toBeUndefined();
      expect(readFileSync(path.join(project.dir, 'late.txt'), 'utf8')).toBe('CANCELLED');
    } finally {
      project.cleanup();
    }
  });

  it('gives each serial member its own outputDir inside the group attempt', async () => {
    const { engine } = createFakeEngine();
    const { outcome, project } = await runProject(
      {
        'tests/serial.e2e.ts': `import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'e2e';

describe('flow', { serial: true }, () => {
  for (const title of ['one', 'two']) {
    test(title, async ({}, testInfo) => {
      writeFileSync(testInfo.outputPath('log.txt'), title);
      appendFileSync(path.join(testInfo.config.projectRoot, 'dirs.txt'), testInfo.outputDir + '\\n');
    });
  }
});
`,
      },
      { config: engineConfig(engine, { retries: 0 }) },
    );
    try {
      expect(outcome.exitCode).toBe(0);
      const dirs = readFileSync(path.join(project.dir, 'dirs.txt'), 'utf8').trim().split('\n');
      expect(dirs).toHaveLength(2);
      expect(new Set(dirs).size).toBe(2);
      expect(path.dirname(dirs[0]!)).toBe(path.dirname(dirs[1]!));
      expect(dirs.map((dir) => readFileSync(path.join(dir, 'log.txt'), 'utf8'))).toEqual(['one', 'two']);
    } finally {
      project.cleanup();
    }
  });

  it('names the declaring module in testInfo.file when the test file imports it', async () => {
    const { engine } = createFakeEngine();
    const { outcome, project } = await runProject(
      {
        'tests/entry.e2e.ts': `import './declared.ts';\n`,
        'tests/declared.ts': `import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'e2e';

test('declared elsewhere', async ({}, testInfo) => {
  writeFileSync(path.join(testInfo.config.projectRoot, 'where.json'), JSON.stringify({ file: testInfo.file, line: testInfo.line }));
});
`,
      },
      { config: engineConfig(engine, { retries: 0 }) },
    );
    try {
      expect(outcome.exitCode).toBe(0);
      const where = JSON.parse(readFileSync(path.join(project.dir, 'where.json'), 'utf8')) as { file: string; line: number };
      const source = outcome.report.run.results[0]!.source;
      expect(source?.file).toBe('tests/declared.ts');
      expect(where).toEqual({ file: path.join(project.dir, 'tests', 'declared.ts'), line: source?.line });
    } finally {
      project.cleanup();
    }
  });

  it('keeps declared annotations on the result of a test whose worker crashed', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/crash.e2e.ts': `import { test } from 'e2e';

test('crashes', { annotation: { type: 'issue', description: 'https://example.com/1' } }, async () => {
  process.exit(7);
});
`,
      },
      { configSource: workerFakeConfigSource(1, '\n  retries: 0,') },
    );
    try {
      assertValidReport(outcome.report);
      const result = outcome.report.run.results[0]!;
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)?.error?.code).toBe('WORKER_CRASH');
      expect(result.attempts.at(-1)?.annotations).toEqual([{ type: 'issue', description: 'https://example.com/1' }]);
      expect(result.annotations).toEqual([{ type: 'issue', description: 'https://example.com/1' }]);
    } finally {
      project.cleanup();
    }
  });

  it('runs a second programmatic run while the first is still in engine init', async () => {
    const files = {
      'tests/a.e2e.ts': `import { test } from 'e2e';
test('passes', async () => {});
`,
    };
    let initStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      initStarted = resolve;
    });
    let releaseInit!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    const slow = createFakeEngine({
      onInit: async () => {
        initStarted();
        await held;
      },
    });
    const first = runProject(files, { config: engineConfig(slow.engine, { retries: 0 }) });
    await started;
    const second = await runProject(files, { config: engineConfig(createFakeEngine().engine, { retries: 0 }) });
    releaseInit();
    const runs = [await first, second];
    try {
      for (const { outcome } of runs) {
        expect(outcome.report.run.results.map((result) => result.status)).toEqual(['passed']);
        expect(outcome.exitCode).toBe(0);
      }
      expect(process.env['TEST_WORKER_INDEX']).toBeUndefined();
      expect(process.env['TEST_PARALLEL_INDEX']).toBeUndefined();
    } finally {
      for (const { project } of runs) project.cleanup();
    }
  });
});
