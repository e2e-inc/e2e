/** `e2e cache ls`, `clear`, and `stats` over a real store directory. */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '@e2e-dev/core/lib/cache/store';
import { main } from '../../src/cli/index.ts';
import type { ActionTrace, TraceProvenance } from '@e2e-dev/core/lib/cache/trace';
import { instructionDigest, paramsDigest } from '@e2e-dev/core/lib/cache/identity';

let root: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

const CACHE_DIR = 'store';

function written(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(spy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join(''));
}

function writeConfig(body: string): void {
  writeFileSync(path.join(root, 'e2e.config.ts'), body, 'utf8');
}

/** The default config of these tests: one target, cache in `store/`. */
function writeDefaultConfig(): void {
  writeConfig(
    `export default { targets: [{ name: 'web', platform: 'web' }], cache: { dir: ${JSON.stringify(CACHE_DIR)} } };\n`,
  );
}

/** A step as an entry records it, with the instruction that digests to its key. */
function step(testId: string, targetId: string, instruction = 'do the thing'): TraceProvenance {
  return {
    testId,
    targetId,
    instructionDigest: instructionDigest(instruction),
    paramsDigest: paramsDigest(undefined),
    callIndex: 0,
    agent: 'default',
    instruction,
  };
}

function trace(recordedFor: TraceProvenance, actions: number): ActionTrace {
  return {
    actions: Array.from({ length: actions }, (_, index) => ({
      name: 'tap' as const,
      summary: `tap ${index}`,
      target: { role: 'button', name: `Button ${index}` },
    })),
    executor: { name: 'example-agent' },
    recordedFor,
    summary: 'step passed',
  };
}

async function seed(entries: readonly { keyHash: string; trace: ActionTrace }[]): Promise<void> {
  const store = new FileCacheStore({
    directory: path.join(root, CACHE_DIR),
    maxBytes: MAX_CACHE_WIRE_BYTES,
    writable: true,
  });
  for (const entry of entries) await store.write(entry.keyHash, entry.trace);
}

async function invoke(...args: string[]): Promise<void> {
  await main(['node', 'e2e', ...args, '--config', path.join(root, 'e2e.config.ts')]);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'e2e-cache-cli-'));
  // The config loader reads .ts config only from an ES module project.
  writeFileSync(path.join(root, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeDefaultConfig();
  process.exitCode = undefined;
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('e2e cache ls', () => {
  it('prints the file, target, step, age, and action count of every recording', async () => {
    await seed([
      { keyHash: 'a'.repeat(64), trace: trace(step('tests/signup.e2e.ts::signs%20up', 'web', 'sign up as {name}'), 3) },
      { keyHash: 'b'.repeat(64), trace: trace(step('tests/billing.e2e.ts::upgrades', 'safari', 'upgrade the plan'), 1) },
      { keyHash: 'c'.repeat(64), trace: trace(step('tests/billing.e2e.ts::upgrades', 'chrome', 'upgrade the plan'), 2) },
    ]);
    await invoke('cache', 'ls');
    const lines = written(stdoutSpy).trimEnd().split('\n');
    expect(process.exitCode).toBe(0);
    expect(lines[0]).toMatch(/^FILE +TARGET +STEP +AGE +ACTIONS$/);
    // File by file, each in the order its recordings were written.
    expect(lines[1]).toMatch(/^billing-upgrades\.yml +safari +upgrade the plan +<1m +1$/);
    expect(lines[2]).toMatch(/^billing-upgrades\.yml +chrome +upgrade the plan +<1m +2$/);
    expect(lines[3]).toMatch(/^signup-signs-up\.yml +web +sign up as \{name\} +<1m +3$/);
  });

  it('marks a recording the action cap cut short', async () => {
    await seed([{ keyHash: 'b'.repeat(64), trace: { ...trace(step('tests/a.e2e.ts::cut', 'web'), 2), truncated: true } }]);
    await invoke('cache', 'ls');
    expect(written(stdoutSpy).trimEnd().split('\n')[1]).toMatch(/ 2 \(truncated\)$/);
  });

  it('cuts a long instruction to one short line', async () => {
    await seed([{ keyHash: 'b'.repeat(64), trace: trace(step('tests/a.e2e.ts::long', 'web', `fill the form\nthen ${'submit '.repeat(20)}`), 1) }]);
    await invoke('cache', 'ls');
    const row = written(stdoutSpy).trimEnd().split('\n')[1]!;
    expect(row).toContain('fill the form then submit submit');
    expect(row).toContain('…');
  });

  it.each([
    { instruction: '中文を入力する', padding: 2, asciiPadding: 10 },
    { instruction: 'type e\u0301', padding: 2, asciiPadding: 2 },
    { instruction: 'type 👩‍💻', padding: 2, asciiPadding: 3 },
  ])('aligns columns for $instruction by displayed width', async ({ instruction, padding, asciiPadding }) => {
    const ascii = 'type a';
    await seed([
      { keyHash: 'a'.repeat(64), trace: trace(step('tests/a.e2e.ts::passes', 'web', ascii), 1) },
      { keyHash: 'b'.repeat(64), trace: trace(step('tests/b.e2e.ts::passes', 'web', instruction), 1) },
    ]);
    await invoke('cache', 'ls');
    const lines = written(stdoutSpy).trimEnd().split('\n');
    expect(process.exitCode).toBe(0);
    expect(lines).toHaveLength(3);
    expect(lines.find((line) => line.startsWith('a-passes'))).toBe(`a-passes.yml  web     ${ascii}${' '.repeat(asciiPadding)}<1m  1`);
    expect(lines.find((line) => line.startsWith('b-passes'))).toBe(`b-passes.yml  web     ${instruction}${' '.repeat(padding)}<1m  1`);
  });

  it('prints no terminal control sequence a recorded instruction holds', async () => {
    await seed([{ keyHash: 'b'.repeat(64), trace: trace(step('tests/a.e2e.ts::red', 'web', 'press \u001b[31mred\u001b[0m'), 1) }]);
    await invoke('cache', 'ls');
    expect(written(stdoutSpy)).toContain('press red');
    expect(written(stdoutSpy)).not.toContain('\u001b');
  });

  it('names the file of an edited recording', async () => {
    await seed([{ keyHash: 'a'.repeat(64), trace: trace(step('tests/a.e2e.ts::edited', 'web', 'open the cart'), 1) }]);
    const file = path.join(root, CACHE_DIR, 'a-edited.yml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('act: open the cart', 'act: empty the cart'), 'utf8');
    await invoke('cache', 'ls');
    expect(written(stderrSpy)).toContain('a-edited.yml: the recording of key aaaaaaaaaaaa on web is not in the YAML as it was written');
    expect(written(stderrSpy)).toContain('a-edited.yml: steps[0] on web has no entry in the lock file');
  });

  it('reports an empty store instead of failing', async () => {
    await invoke('cache', 'ls');
    expect(written(stdoutSpy)).toContain('no replay cache entries in');
    expect(process.exitCode).toBe(0);
  });

  it('counts a file the store cannot read as unreadable, not as an entry, and says why', async () => {
    await seed([{ keyHash: 'a'.repeat(64), trace: trace(step('tests/a.e2e.ts::torn', 'web'), 1) }]);
    writeFileSync(path.join(root, CACHE_DIR, 'a-torn.yml'), 'steps: [ torn', 'utf8');
    await invoke('cache', 'ls');
    expect(written(stdoutSpy)).toContain('no replay cache entries in');
    expect(written(stderrSpy)).toContain('1 recording(s)');
    expect(written(stderrSpy)).toContain('a-torn.yml');
  });

  it('names entries an older e2e wrote, which no run reads', async () => {
    mkdirSync(path.join(root, CACHE_DIR), { recursive: true });
    writeFileSync(path.join(root, CACHE_DIR, `${'c'.repeat(64)}.json`), '{}', 'utf8');
    await invoke('cache', 'ls');
    expect(written(stdoutSpy)).toContain('no replay cache entries in');
    expect(written(stderrSpy)).toContain('1 file(s)');
    expect(written(stderrSpy)).toContain('which no run reads');
  });
});

describe('e2e cache stats', () => {
  it('prints the directory, the entry count, and the size', async () => {
    await seed([
      { keyHash: 'a'.repeat(64), trace: trace(step('tests/a.e2e.ts::one', 'web'), 1) },
      { keyHash: 'b'.repeat(64), trace: trace(step('tests/a.e2e.ts::one', 'ios'), 1) },
      { keyHash: 'c'.repeat(64), trace: trace(step('tests/a.e2e.ts::two', 'web'), 1) },
    ]);
    await invoke('cache', 'stats');
    const output = written(stdoutSpy);
    expect(output).toContain(`directory  ${path.join(root, CACHE_DIR)}`);
    expect(output).toContain('tests      2');
    expect(output).toContain('entries    3');
    expect(output).toMatch(/size {7}\d+(\.\d)? (B|KiB)/);
  });

  it('reads the directory --cache-dir or E2E_CACHE_DIR names over cache.dir', async () => {
    await invoke('cache', 'stats', '--cache-dir', 'from-flag');
    expect(written(stdoutSpy)).toContain(`directory  ${path.join(root, 'from-flag')}`);
    stdoutSpy.mockClear();
    vi.stubEnv('E2E_CACHE_DIR', 'from-env');
    try {
      await invoke('cache', 'stats');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(written(stdoutSpy)).toContain(`directory  ${path.join(root, 'from-env')}`);
  });
});

describe('e2e cache clear', () => {
  it('deletes the recordings and the directory', async () => {
    await seed([
      { keyHash: 'a'.repeat(64), trace: trace(step('tests/a.e2e.ts::one', 'web'), 1) },
      { keyHash: 'b'.repeat(64), trace: trace(step('tests/a.e2e.ts::two', 'web'), 1) },
    ]);
    await invoke('cache', 'clear');
    // Each test's YAML file and its lock.
    expect(written(stdoutSpy)).toContain('cleared 4 file(s)');
    expect(readdirSync(root).toSorted()).toEqual(['e2e.config.ts', 'package.json']);
    expect(process.exitCode).toBe(0);
  });

  it('removes an unreadable recording, an older e2e\u2019s entry, and a crashed writer\u2019s leftovers', async () => {
    const directory = path.join(root, CACHE_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'a-torn.yml'), '# Replay recording of one e2e test. Review it\nsteps: [ torn', 'utf8');
    // A pair a later e2e wrote, its lock in a format this one does not read.
    writeFileSync(path.join(directory, 'a-later.yml'), '# Replay recording of one e2e test. Review it\nsteps: []\n', 'utf8');
    writeFileSync(path.join(directory, 'a-later.lock.json'), '{\n  "format": "e2e-replay-lock-2",\n  "entries": []\n}\n', 'utf8');
    writeFileSync(path.join(directory, `${'c'.repeat(64)}.json`), 'torn', 'utf8');
    writeFileSync(path.join(directory, 'a-torn.yml.0123456789abcdef.tmp'), '{}', 'utf8');
    writeFileSync(path.join(directory, '.a-torn.pending.0123456789abcdef.tmp'), '{}', 'utf8');
    writeFileSync(path.join(directory, '.a-torn.writing'), 'c'.repeat(32), 'utf8');
    writeFileSync(path.join(directory, '.a-torn.writing.takeover'), 'c'.repeat(32), 'utf8');
    // A writer that died between creating its lock and writing the token in it.
    writeFileSync(path.join(directory, '.b-torn.writing'), '', 'utf8');
    writeFileSync(path.join(directory, '.a-torn.pending'), JSON.stringify({ name: 'a-torn', yamlDigest: 'd'.repeat(64), lock: '{}', replaces: null }), 'utf8');
    // A crashed writer's: old enough to be stale.
    const old = new Date(Date.now() - 60_000);
    for (const name of readdirSync(directory)) utimesSync(path.join(directory, name), old, old);
    await invoke('cache', 'clear');
    expect(written(stdoutSpy)).toMatch(/cleared \d+ file\(s\)/u);
    // What it just deleted is not reported as still there.
    expect(written(stderrSpy)).toBe('');
    expect(readdirSync(root).toSorted()).toEqual(['e2e.config.ts', 'package.json']);
  });

  it('leaves files the runner never wrote, and says so', async () => {
    const directory = path.join(root, CACHE_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'notes.md'), 'keep me', 'utf8');
    // Named like recordings, but nothing in them says the runner wrote them.
    writeFileSync(path.join(directory, 'ci.yml'), 'on: push\n', 'utf8');
    writeFileSync(path.join(directory, 'tool.lock.json'), '{"version": 1}\n', 'utf8');
    // A manifest that names the store's format somewhere inside, not as its own.
    writeFileSync(path.join(directory, 'artifacts.lock.json'), '{\n  "artifacts": [{ "format": "e2e-replay-lock-1" }]\n}\n', 'utf8');
    // Named like the store's lock, but with something in it: another tool's.
    writeFileSync(path.join(directory, '.index.writing'), 'pid 42\n', 'utf8');
    // Named like the store's pending pair record, but not one.
    writeFileSync(path.join(directory, '.index.pending'), 'queued\n', 'utf8');
    // Shaped like a writer's temporary file, under a stem no test's name can take.
    writeFileSync(path.join(directory, 'deployment--prod.yml.0123456789abcdef.tmp'), 'stage: prod\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path.join(directory, '.index.pending'), old, old);
    utimesSync(path.join(directory, 'deployment--prod.yml.0123456789abcdef.tmp'), old, old);
    await invoke('cache', 'clear');
    expect(written(stderrSpy)).toContain('notes.md');
    expect(written(stderrSpy)).toContain('ci.yml');
    expect(written(stderrSpy)).toContain('.index.pending');
    expect(readdirSync(directory).toSorted()).toEqual(['.index.pending', '.index.writing', 'artifacts.lock.json', 'ci.yml', 'deployment--prod.yml.0123456789abcdef.tmp', 'notes.md', 'tool.lock.json']);
  });

  it('leaves a YAML another tool wrote over a recording, and deletes the lock beside it', async () => {
    await seed([{ keyHash: 'a'.repeat(64), trace: trace(step('tests/a.e2e.ts::settings', 'web'), 1) }]);
    const directory = path.join(root, CACHE_DIR);
    writeFileSync(path.join(directory, 'a-settings.yml'), 'on: push\n', 'utf8');
    await invoke('cache', 'clear');
    expect(readdirSync(directory)).toEqual(['a-settings.yml']);
  });

  it('leaves the lock and temporary file of a writer still at work', async () => {
    const directory = path.join(root, CACHE_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, '.a-live.writing'), 'c'.repeat(32), 'utf8');
    writeFileSync(path.join(directory, 'a-live.yml.0123456789abcdef.tmp'), 'half', 'utf8');
    writeFileSync(path.join(directory, '.a-live.pending'), JSON.stringify({ name: 'a-live', yamlDigest: 'd'.repeat(64), lock: '{}', replaces: null }), 'utf8');
    await invoke('cache', 'clear');
    expect(readdirSync(directory).toSorted()).toEqual(['.a-live.pending', '.a-live.writing', 'a-live.yml.0123456789abcdef.tmp']);
  });

  it('does not call a crashed writer\u2019s pending pair record another tool\u2019s file', async () => {
    await seed([{ keyHash: 'a'.repeat(64), trace: trace(step('tests/a.e2e.ts::settings', 'web'), 1) }]);
    const directory = path.join(root, CACHE_DIR);
    writeFileSync(path.join(directory, '.a-settings.pending'), JSON.stringify({ name: 'a-settings', yamlDigest: 'd'.repeat(64), lock: '{}', replaces: null }), 'utf8');
    await invoke('cache', 'ls');
    expect(written(stderrSpy)).not.toContain('not cache files');
  });

  // Root reads anything, and Windows ignores the mode: neither has a file it cannot open.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names a recording it cannot open as unreadable, and leaves it', async () => {
    await seed([{ keyHash: 'a'.repeat(64), trace: trace(step('tests/a.e2e.ts::settings', 'web'), 1) }]);
    const directory = path.join(root, CACHE_DIR);
    const pair = ['a-settings.yml', 'a-settings.lock.json'].map((name) => path.join(directory, name));
    for (const file of pair) chmodSync(file, 0o000);
    try {
      await invoke('cache', 'ls');
      expect(written(stderrSpy)).toContain('not readable');
      expect(written(stderrSpy)).not.toContain('not cache files');
      stderrSpy.mockClear();
      await invoke('cache', 'clear');
      expect(written(stderrSpy)).toContain('could not be opened and were left alone: a-settings.yml');
      expect(readdirSync(directory).toSorted()).toEqual(['a-settings.lock.json', 'a-settings.yml']);
    } finally {
      for (const file of pair) chmodSync(file, 0o600);
    }
  });

  it('has nothing to clear when the store was never written', async () => {
    await invoke('cache', 'clear');
    expect(written(stdoutSpy)).toContain('no replay cache entries to clear');
    expect(process.exitCode).toBe(0);
  });
});

describe('e2e cache configuration', () => {
  it('refuses a custom store it cannot enumerate', async () => {
    writeConfig(
      [
        "const store = { writable: false, read: async () => ({ status: 'miss' }), write: async () => undefined };",
        "export default { targets: [{ name: 'web', platform: 'web' }], cache: { store } };",
        '',
      ].join('\n'),
    );
    await invoke('cache', 'stats');
    expect(written(stderrSpy)).toContain('cache.store replaces the file store');
    expect(process.exitCode).toBe(2);
  });

  it('fails with the config error when the config is missing', async () => {
    rmSync(path.join(root, 'e2e.config.ts'));
    await invoke('cache', 'ls');
    expect(written(stderrSpy)).toContain('config file not found');
    expect(process.exitCode).toBe(2);
  });
});
