/** The file store: one reviewable YAML file and one generated lock per test, fail-to-miss reads. */

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { instructionDigest, paramsDigest } from '@e2e-dev/core/lib/cache/identity';
import { holdsFileLock, withFileLock } from '@e2e-dev/core/lib/cache/file-lock';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '@e2e-dev/core/lib/cache/store';
import { expandTrace, templateTrace, type ParamTemplate } from '@e2e-dev/core/lib/cache/template';
import { MAX_TRACE_TEST_ID_CHARS, type ActionTrace, type TraceProvenance } from '@e2e-dev/core/lib/cache/trace';
import { bound } from '@e2e-dev/core/lib/internal/text';
import { MAX_PARAMS_DEPTH, validateJsonValue } from '@e2e-dev/core/lib/internal/json-value';
import type { JsonValue } from '@e2e-dev/core/lib/types';

const KEY = 'a'.repeat(64);
/** What a lock file holds: its holder's token. */
const LOCK_TOKEN = 'c'.repeat(32);
const OTHER_KEY = 'b'.repeat(64);
const TEST_ID = 'tests/settings.e2e.ts::settings::upgrades%20the%20plan';
const NAME = 'settings-upgrades-the-plan';
const INSTRUCTION = 'upgrade the plan to {tier}';
const PARAMS = { tier: 'Pro' };

function step(targetId = 'web', overrides: Partial<TraceProvenance> = {}): TraceProvenance {
  return {
    testId: TEST_ID,
    targetId,
    instructionDigest: instructionDigest(INSTRUCTION),
    paramsDigest: paramsDigest(PARAMS),
    callIndex: 0,
    agent: 'default',
    instruction: INSTRUCTION,
    params: PARAMS,
    ...overrides,
  };
}

function payload(targetId = 'web', overrides: Partial<ActionTrace> = {}): ActionTrace {
  return {
    actions: [
      { name: 'tap', summary: 'tap button "Upgrade"', target: { role: 'button', name: 'Upgrade', within: 'Plan' } },
      { name: 'type', summary: 'type "Pro" into textbox "Tier"', target: { role: 'textbox', name: 'Tier' }, value: 'Pro' },
      { name: 'pressKey', summary: 'press "Enter" on the focused field', key: 'Enter' },
      { name: 'back', summary: 'navigate back' },
    ],
    executor: { name: 'example-agent', version: '1' },
    recordedFor: step(targetId),
    summary: 'upgraded the plan',
    startPath: '/settings',
    endPath: '/settings',
    endAnchors: [{ role: 'status', text: 'Plan: Pro' }],
    goneAnchors: [{ role: 'button', name: 'Upgrade', position: { index: 0, of: 2 } }],
    endWaitMs: 11_234,
    ...overrides,
  };
}

/** Temp dirs the cases here create, removed after each so a run leaves nothing behind. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStore(options: { maxBytes?: number; writable?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-trace-cache-'));
  tempDirs.push(directory);
  return {
    directory,
    store: new FileCacheStore({
      directory,
      maxBytes: options.maxBytes ?? MAX_CACHE_WIRE_BYTES,
      writable: options.writable ?? true,
    }),
  };
}

const yamlPath = (directory: string, name = NAME) => path.join(directory, `${name}.yml`);
const lockPath = (directory: string, name = NAME) => path.join(directory, `${name}.lock.json`);

describe('FileCacheStore', () => {
  it('writes one test as a YAML file named for it, and reads every field back', async () => {
    const { directory, store } = await makeStore();
    const written = await store.write(KEY, payload());
    expect(written?.bytes).toBeGreaterThan(0);
    expect((await readdir(directory)).toSorted()).toEqual([`${NAME}.lock.json`, `${NAME}.yml`]);
    expect(await readFile(yamlPath(directory), 'utf8')).toBe(
      [
        '# Replay recording of one e2e test. Review it like code: each step lists what',
        '# a replay does (do) and what it checks before the step passes (expect).',
        "# Don't edit it: an edited recording no longer replays, and the test records",
        '# nothing until the edit is undone. To record a step again, delete it here.',
        `# Keys and digests: ${NAME}.lock.json`,
        '',
        'test: settings › upgrades the plan',
        'file: tests/settings.e2e.ts',
        '',
        'steps:',
        '  - act: upgrade the plan to {tier}',
        '    params:',
        '      tier: Pro',
        '    targets:',
        '      web:',
        '        at: /settings',
        '        do:',
        '          - tap: { role: button, name: Upgrade, within: Plan }',
        '          - type: Pro',
        '            into: { role: textbox, name: Tier }',
        '          - press: Enter',
        '          - back',
        '        expect:',
        '          shows:',
        '            - { role: status, text: "Plan: Pro" }',
        '          gone:',
        '            - { role: button, name: Upgrade, position: { index: 0, of: 2 } }',
        '',
      ].join('\n'),
    );
    const read = await store.read(KEY, step());
    expect(read.status).toBe('hit');
    // The end wait is kept in whole seconds, rounded up; the action summaries are written again from the actions.
    expect(read.status === 'hit' && read.entry.payload).toEqual({
      ...payload(),
      actions: [
        { name: 'tap', summary: 'tap button "Upgrade" in "Plan"', target: { role: 'button', name: 'Upgrade', within: 'Plan' } },
        payload().actions[1],
        payload().actions[2],
        payload().actions[3],
      ],
      endWaitMs: 12_000,
    });
    // A read without the step finds the entry by listing the directory.
    expect((await store.read(KEY)).status).toBe('hit');
    const lock = JSON.parse(await readFile(lockPath(directory), 'utf8'));
    expect(lock).toMatchObject({ format: 'e2e-replay-lock-1', testId: TEST_ID, entries: [{ key: KEY, target: 'web', digest: expect.stringMatching(/^[a-f0-9]{64}$/u) }] });
  });

  it('lists one step recorded on two targets under one act, and drops each on its own', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload('web'));
    await store.write(OTHER_KEY, payload('ios', { startPath: '/a', endPath: '/b' }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    expect(yaml.match(/- act:/gu)).toHaveLength(1);
    expect(yaml).toContain('      web:\n        at: /settings\n');
    expect(yaml).toContain('      ios:\n        from: /a\n        to: /b\n');
    expect((await store.read(OTHER_KEY, step('ios'))).status).toBe('hit');

    await store.delete(KEY, step('web'));
    expect((await store.read(KEY, step('web'))).status).toBe('miss');
    expect((await store.read(OTHER_KEY, step('ios'))).status).toBe('hit');
    await store.delete(OTHER_KEY, step('ios'));
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps the time a recording was made only while its flow is the same', async () => {
    const { directory, store } = await makeStore();
    const createdAt = async () => JSON.parse(await readFile(lockPath(directory), 'utf8')).entries[0].createdAt as string;
    await store.write(KEY, payload());
    const first = await createdAt();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Its provenance completed under the same key: the same recording.
    await store.write(KEY, payload('web', { summary: 'upgraded the plan, confirmed' }));
    expect(await createdAt()).toBe(first);
    // A new flow under the same key (a live run of a step that has an entry): a new recording.
    await store.write(KEY, payload('web', { startPath: '/billing', endPath: '/billing' }));
    expect(await createdAt()).not.toBe(first);
  });

  it('keeps one recording per step and target, replacing it whatever its key', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { summary: 'upgraded again' }));
    expect((await store.read(KEY, step())).status).toBe('miss');
    expect((await store.read(OTHER_KEY, step())).status).toBe('hit');
    const lock = JSON.parse(await readFile(lockPath(directory), 'utf8'));
    expect(lock.entries).toHaveLength(1);
  });

  it('lists a repeated instruction as two steps, in the order they were recorded', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { recordedFor: step('web', { callIndex: 1 }) }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    expect(yaml.match(/- act:/gu)).toHaveLength(2);
    // Steps are blocks of their own: a blank line before each.
    expect(yaml).toContain('upgrade the plan to {tier}\n');
    expect(yaml).toContain('\n\n  - act:');
    expect((await store.read(OTHER_KEY, step('web', { callIndex: 1 }))).status).toBe('hit');
  });

  it('keeps the newer of two recordings a merge left for one step and target, and binds neither key to the other', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload('web', { startPath: '/a', endPath: '/a' }));
    const [firstYaml, firstLock] = [await readFile(yamlPath(directory), 'utf8'), JSON.parse(await readFile(lockPath(directory), 'utf8'))];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.write(OTHER_KEY, payload('web', { startPath: '/b', endPath: '/b' }));
    const [secondYaml, secondLock] = [await readFile(yamlPath(directory), 'utf8'), JSON.parse(await readFile(lockPath(directory), 'utf8'))];
    // Two branches each recorded the step under their own key, and git kept both.
    await writeFile(yamlPath(directory), `${firstYaml}\n${secondYaml.slice(secondYaml.indexOf('  - act:'))}`, 'utf8');
    await writeFile(lockPath(directory), JSON.stringify({ ...firstLock, entries: [...firstLock.entries, ...secondLock.entries] }), 'utf8');
    expect((await store.read(KEY, step())).status).toBe('hit');
    // An unrelated step records, rewriting the file.
    const other = step('web', { instruction: 'open the cart', instructionDigest: instructionDigest('open the cart') });
    expect(await store.write('c'.repeat(64), payload('web', { recordedFor: other }))).toBeDefined();
    expect((await store.read(KEY, step())).status).toBe('miss');
    const kept = await store.read(OTHER_KEY, step());
    expect(kept.status === 'hit' && kept.entry.payload.startPath).toBe('/b');
  });

  it('tells two alike runs of one act apart, so deleting one leaves the other', async () => {
    const { directory, store } = await makeStore();
    const [first, second] = [step(), step('web', { callIndex: 1 })];
    await store.write(KEY, payload('web', { recordedFor: first }));
    await store.write(OTHER_KEY, payload('web', { recordedFor: second }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    expect(yaml).toContain('    call: 2\n');
    // Delete the first run's block: its key no longer replays, the second's still does.
    const start = yaml.indexOf('  - act:');
    await writeFile(yamlPath(directory), `${yaml.slice(0, start)}${yaml.slice(yaml.indexOf('\n\n  - act:') + 2)}`, 'utf8');
    expect((await store.read(KEY, first)).status).toBe('miss');
    expect((await store.read(OTHER_KEY, second)).status).toBe('hit');
  });

  it('reads back params nested as deep as agent.act accepts', async () => {
    const { store } = await makeStore();
    // 32 levels of objects around a string, the deepest the params validation lets through.
    let deep: Record<string, JsonValue> = { leaf: 'x' };
    for (let level = 1; level < 32; level += 1) deep = { next: deep };
    validateJsonValue(deep, 'params', { maxDepth: MAX_PARAMS_DEPTH });
    const deepStep = step('web', { params: deep, paramsDigest: paramsDigest(deep) });
    await store.write(KEY, payload('web', { recordedFor: deepStep }));
    expect((await store.read(KEY, deepStep)).status).toBe('hit');
  });

  it('reads back a value with line breaks as written, in a descriptor and as typed text', async () => {
    const { store } = await makeStore();
    const actions = [
      { name: 'tap', summary: 'tap', target: { role: 'text', name: 'Total:\n$42' } },
      { name: 'type', summary: 'type', target: { role: 'textbox', name: 'Note' }, value: ' \n' },
      { name: 'type', summary: 'type', target: { role: 'textbox', name: 'Lines' }, value: 'one\n  two\n' },
    ] as const;
    expect(await store.write(KEY, payload('web', { actions: [...actions], endAnchors: [{ role: 'status', text: 'Saved:\nnow' }] }))).toBeDefined();
    const read = await store.read(KEY, step());
    expect(read.status === 'hit' && read.entry.payload.actions.map((action) => ('value' in action ? action.value : (action as { target: { name: string } }).target.name))).toEqual([
      'Total:\n$42',
      ' \n',
      'one\n  two\n',
    ]);
    expect(read.status === 'hit' && read.entry.payload.endAnchors).toEqual([{ role: 'status', text: 'Saved:\nnow' }]);
  });

  it('writes a target whatever its name', async () => {
    const { store } = await makeStore();
    await store.write(KEY, payload('__proto__'));
    expect((await store.read(KEY, step('__proto__'))).status).toBe('hit');
  });

  it('keeps two tests with a long shared title apart, each step with its targets', async () => {
    const { directory, store } = await makeStore();
    // Titles in Japanese, percent-encoded: hundreds of characters before the two tests differ.
    const title = '%E6%B3%A8%E6%96%87'.repeat(30);
    const [first, second] = [`tests/order.e2e.ts::${title}::a`, `tests/order.e2e.ts::${title}::b`];
    await store.write(KEY, payload('web', { recordedFor: step('web', { testId: first }) }));
    await store.write(OTHER_KEY, payload('ios', { recordedFor: step('ios', { testId: first }) }));
    await store.write('c'.repeat(64), payload('web', { recordedFor: step('web', { testId: second }) }));
    const files = (await readdir(directory)).filter((name) => name.endsWith('.yml'));
    expect(files).toHaveLength(2);
    const acts = await Promise.all(files.map(async (name) => (await readFile(path.join(directory, name), 'utf8')).match(/- act:/gu)?.length));
    expect(acts).toEqual([1, 1]);
    expect((await store.read(OTHER_KEY, step('ios', { testId: first }))).status).toBe('hit');
  });

  it('names the file a test with a long id records into', async () => {
    const { directory, store } = await makeStore();
    const longId = `tests/${'component/'.repeat(6_600)}pay.e2e.ts::pays`;
    // A recording keeps the test id cut to its bound, and the store names the file from that.
    await store.write(KEY, payload('web', { recordedFor: step('web', { testId: bound(longId, MAX_TRACE_TEST_ID_CHARS) }) }));
    const written = (await readdir(directory)).find((name) => name.endsWith('.yml'));
    expect(await store.recordingFile(longId)).toBe(written);
  });

  it('puts a step added to the middle of a test in the middle of its file', async () => {
    const { directory, store } = await makeStore();
    const named = (instruction: string) => step('web', { instruction, instructionDigest: instructionDigest(instruction) });
    const [first, middle, last] = [named('open the cart'), named('add a mug'), named('check out')];
    await store.write(KEY, payload('web', { recordedFor: first }));
    await store.write(OTHER_KEY, payload('web', { recordedFor: last }));
    // The next run reads the steps in the test's order, the new one included, and records it.
    const next = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    for (const [key, read] of [[KEY, first], ['c'.repeat(64), middle], [OTHER_KEY, last]] as const) await next.read(key, read);
    await next.write('c'.repeat(64), payload('web', { recordedFor: middle }));
    const acts = (await readFile(yamlPath(directory), 'utf8')).match(/- act: .*/gu);
    expect(acts).toEqual(['- act: open the cart', '- act: add a mug', '- act: check out']);
  });

  it('puts a new step before the next step the test ran, in a file a person reordered', async () => {
    const { directory, store } = await makeStore();
    const named = (instruction: string) => step('web', { instruction, instructionDigest: instructionDigest(instruction) });
    const [a, b, c, added] = [named('open the cart'), named('add a mug'), named('check out'), named('apply the coupon')];
    // The file holds c, a, b: the order a person left it in.
    for (const [index, recorded] of [c, a, b].entries()) await store.write(String(index).repeat(64), payload('web', { recordedFor: recorded }));
    const next = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    for (const [key, read] of [['1'.repeat(64), a], ['9'.repeat(64), added], ['2'.repeat(64), b], ['0'.repeat(64), c]] as const) await next.read(key, read);
    await next.write('9'.repeat(64), payload('web', { recordedFor: added }));
    const acts = (await readFile(yamlPath(directory), 'utf8')).match(/- act: .*/gu);
    expect(acts).toEqual(['- act: check out', '- act: open the cart', '- act: apply the coupon', '- act: add a mug']);
  });

  it('evicts a recording of a test whose file name is cut', async () => {
    const { directory, store } = await makeStore();
    const longFile = step('web', { testId: 'tests/this-is-a-very-long-test-file-name-that-describes-a-whole-scenario-in-great-detail-indeed.e2e.ts::buys%20a%20mug' });
    await store.write(KEY, payload('web', { recordedFor: longFile }));
    expect((await store.read(KEY, longFile)).status).toBe('hit');
    await store.delete(KEY, longFile);
    expect((await store.read(KEY, longFile)).status).toBe('miss');
    expect(await readdir(directory)).toEqual([]);
  });

  it('replays a unique() value whose parameter is named with a quote', async () => {
    const { store } = await makeStore();
    const customer = (value: string): ParamTemplate[] => [{ pointer: '/Customer "ID"', value }];
    const typed = payload('web', {
      actions: [{ name: 'type', summary: 'type "acme-123" into textbox "Customer"', target: { role: 'textbox', name: 'Customer' }, value: 'acme-123' }],
    });
    await store.write(KEY, templateTrace(typed, customer('acme-123'))!);
    const read = await store.read(KEY, step());
    expect(read.status).toBe('hit');
    // The summary the YAML's reader makes quotes the slot, escaping the quotes in its name.
    const replayed = read.status === 'hit' ? expandTrace(read.entry.payload, customer('acme-456')) : undefined;
    expect(replayed?.actions[0]).toMatchObject({ value: 'acme-456', summary: 'type "acme-456" into textbox "Customer"' });
  });

  it('reads a createAgent cache key as written, whatever it spells', async () => {
    const { directory, store } = await makeStore();
    const standalone = step('web', { testId: 'core:checkout::confirm%20order' });
    await store.write(KEY, payload('web', { recordedFor: standalone }));
    const name = (await readdir(directory)).find((file) => file.endsWith('.yml'));
    const yaml = await readFile(path.join(directory, name!), 'utf8');
    expect(yaml).toContain('\ntest: core:checkout::confirm%20order\n');
    expect(yaml).not.toContain('\nfile:');
    expect((await store.read(KEY, standalone)).status).toBe('hit');
  });

  it("names a setup test's file and titles, not its id's prefix", async () => {
    const { directory, store } = await makeStore();
    const setup = step('web', { testId: 'setup::tests/auth.setup.ts::signs%20in' });
    await store.write(KEY, payload('web', { recordedFor: setup }));
    expect(await readdir(directory)).toContain('auth-signs-in-setup.yml');
    const yaml = await readFile(path.join(directory, 'auth-signs-in-setup.yml'), 'utf8');
    expect(yaml).toContain('\ntest: signs in (setup)\nfile: tests/auth.setup.ts\n');
    expect((await store.read(KEY, setup)).status).toBe('hit');
  });

  it('saves and replays a recording whose key context the trace reader leaves out', async () => {
    const { store } = await makeStore();
    // A platform label longer than the trace reader keeps: provenance for diagnostics, not a replay input.
    const keyedBy = {
      cacheSchema: 'trace-1', policyVersion: '1', project: 'p', platform: 'linux-ui-'.repeat(35), engineName: 'web', engineSpiVersion: 1, appIdentity: 'http://127.0.0.1:4280/', agentContextDigest: 'd'.repeat(64),
    };
    expect(await store.write(KEY, payload('web', { keyedBy }))).toBeDefined();
    const read = await store.read(KEY, step());
    expect(read.status).toBe('hit');
    expect(read.status === 'hit' ? read.entry.payload.keyedBy : 'missing').toBeUndefined();
    // The same context with a short label is kept.
    await store.write(KEY, payload('web', { keyedBy: { ...keyedBy, platform: 'linux' } }));
    const short = await store.read(KEY, step());
    expect(short.status === 'hit' ? short.entry.payload.keyedBy?.platform : undefined).toBe('linux');
  });

  it('writes many steps of a test together as the same file one at a time would', async () => {
    const steps = Array.from({ length: 6 }, (_, index) => step('web', { callIndex: index }));
    const writes = steps.map((recordedFor, index) => ({ keyHash: String(index).repeat(64), payload: payload('web', { recordedFor }) }));
    const together = await makeStore();
    const answers = await together.store.writeAll(writes);
    expect(answers.every((answer) => answer !== undefined)).toBe(true);
    const alone = await makeStore();
    for (const { keyHash, payload: trace } of writes) await alone.store.write(keyHash, trace);
    const shape = (yaml: string) => yaml.replaceAll(/createdAt: .*/gu, '');
    expect(shape(await readFile(yamlPath(together.directory), 'utf8'))).toBe(shape(await readFile(yamlPath(alone.directory), 'utf8')));
    for (const [index, recordedFor] of steps.entries()) expect((await together.store.read(String(index).repeat(64), recordedFor)).status).toBe('hit');
  });

  it('falls back to one write at a time when writing a batch together throws', async () => {
    const { directory } = await makeStore();
    const steps = [0, 1, 2].map((index) => step('web', { callIndex: index }));
    // The first rename of the batch fails once, as a file a scanner holds open can on Windows.
    const script = `
      import fsp from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const { rename } = fsp;
      let failed = false;
      fsp.rename = (from, to) => {
        if (!failed) {
          failed = true;
          return Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM' }));
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      const { FileCacheStore } = await import('@e2e-dev/core/lib/cache/store');
      const store = new FileCacheStore({ directory: ${JSON.stringify(directory)}, maxBytes: ${String(MAX_CACHE_WIRE_BYTES)}, writable: true });
      const writes = ${JSON.stringify(steps.map((recordedFor, index) => ({ keyHash: String(index).repeat(64), payload: payload('web', { recordedFor }) })))};
      process.stdout.write(JSON.stringify((await store.writeAll(writes)).map((answer) => answer !== undefined)));
    `;
    const output = await new Promise<string>((resolve) => {
      let text = '';
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd() });
      child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
      child.on('exit', () => resolve(text));
    });
    expect(JSON.parse(output)).toEqual([true, true, true]);
    const store = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
    for (const [index, recordedFor] of steps.entries()) expect((await store.read(String(index).repeat(64), recordedFor)).status).toBe('hit');
  });

  it('answers each write of a batch as it would alone when the pair cannot take them together', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    const yaml = await readFile(yamlPath(directory), 'utf8');
    // An edited recording: the pair takes no write, together or alone.
    await writeFile(yamlPath(directory), yaml.replace('at: /settings', 'at: /plans'), 'utf8');
    const answers = await store.writeAll([{ keyHash: OTHER_KEY, payload: payload('ios') }, { keyHash: 'c'.repeat(64), payload: payload('android') }]);
    expect(answers).toEqual([undefined, undefined]);
  });

  it('names an agent other than the default on its step', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload('web', { recordedFor: step('web', { agent: 'admin' }) }));
    expect(await readFile(yamlPath(directory), 'utf8')).toContain('    agent: admin\n');
    expect((await store.read(KEY, step('web', { agent: 'admin' }))).status).toBe('hit');
  });

  it('gives a second test whose name comes out the same its own file', async () => {
    const { directory, store } = await makeStore();
    const otherTest = 'tests/settings.e2e.ts::settings::upgrades%20the%20plan!';
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { recordedFor: step('web', { testId: otherTest }) }));
    const names = (await readdir(directory)).filter((name) => name.endsWith('.yml')).toSorted();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^settings-upgrades-the-plan--[a-f0-9]{12}\.yml$/u);
    expect(names[1]).toBe(`${NAME}.yml`);
    expect((await store.read(KEY, step())).status).toBe('hit');
    expect((await store.read(OTHER_KEY, step('web', { testId: otherTest }))).status).toBe('hit');
    expect((await store.read(KEY, step('web', { testId: otherTest }))).status).toBe('miss');
    // The file each test's recordings are in, never the other's.
    expect(await store.recordingFile(TEST_ID)).toBe(`${NAME}.yml`);
    expect(await store.recordingFile(otherTest)).toBe(names[0]);
  });

  it('names a test whose title its name cannot spell the same whichever test records first', async () => {
    const filesAfter = async (order: readonly string[]) => {
      const { store } = await makeStore();
      for (const [index, testId] of order.entries()) await store.write(String(index).repeat(64), payload('web', { recordedFor: step('web', { testId }) }));
      return Object.fromEntries(await Promise.all(order.map(async (testId) => [testId, await store.recordingFile(testId)] as const)));
    };
    // A test's titles, and a createAgent cache key (`core:<key>`), which has none.
    for (const [first, second, name] of [
      ['tests/login.e2e.ts::%E3%83%AD%E3%82%B0%E3%82%A4%E3%83%B3', 'tests/login.e2e.ts::%E3%83%AD%E3%82%B0%E3%82%A2%E3%82%A6%E3%83%88', 'login'],
      ['core:買い物', 'core:会計', 'core'],
    ] as const) {
      const one = await filesAfter([first, second]);
      expect(one[first]).toMatch(new RegExp(`^${name}--[a-f0-9]{12}\\.yml$`, 'u'));
      expect(one[second]).toMatch(new RegExp(`^${name}--[a-f0-9]{12}\\.yml$`, 'u'));
      expect(one[first]).not.toBe(one[second]);
      expect(await filesAfter([second, first])).toEqual(one);
    }
  });

  it('names tests of same-named files in different folders, or files told apart by a dot, apart', async () => {
    const { directory, store } = await makeStore();
    const files = ['tests/admin/login.e2e.ts', 'tests/shop/login.e2e.ts', 'tests/login.web.e2e.ts', 'tests/login.mobile.e2e.ts'];
    for (const [index, file] of files.entries()) {
      await store.write(String(index).repeat(64), payload('web', { recordedFor: step('web', { testId: `${file}::signs%20in` }) }));
    }
    expect((await readdir(directory)).filter((name) => name.endsWith('.yml')).toSorted()).toEqual([
      'admin-login-signs-in.yml',
      'login-mobile-signs-in.yml',
      'login-web-signs-in.yml',
      'shop-login-signs-in.yml',
    ]);
  });

  it('writes a test whose name carries its hash under the lock that clearing and evicting take', async () => {
    const { directory, store } = await makeStore();
    const testId = 'tests/login.e2e.ts::%E3%83%AD%E3%82%B0%E3%82%A4%E3%83%B3';
    let wrote = false;
    let writing: Promise<void> | undefined;
    await withFileLock(path.join(directory, '.login.writing'), async () => {
      writing = store.write(KEY, payload('web', { recordedFor: step('web', { testId }) })).then(() => {
        wrote = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(wrote).toBe(false);
    });
    await writing;
    expect(wrote).toBe(true);
    expect((await store.read(KEY, step('web', { testId }))).status).toBe('hit');
  });

  it('writes two targets of one test at once without losing either', async () => {
    const { store } = await makeStore();
    const targets = ['web', 'ios', 'android', 'desktop'];
    await Promise.all(targets.map((targetId, index) => store.write(String(index).repeat(64), payload(targetId))));
    for (const [index, targetId] of targets.entries()) {
      expect((await store.read(String(index).repeat(64), step(targetId))).status).toBe('hit');
    }
  });

  it('takes over the lock a writer that died holding it left behind', async () => {
    const { directory, store } = await makeStore();
    const stale = path.join(directory, `.${NAME}.writing`);
    await writeFile(stale, LOCK_TOKEN, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(stale, old, old);
    expect(await store.write(KEY, payload())).toBeDefined();
    expect(await readdir(directory)).not.toContain(`.${NAME}.writing`);
  });

  it('never takes over an old file at the lock path that has something in it', async () => {
    const { directory, store } = await makeStore();
    const foreign = path.join(directory, `.${NAME}.writing`);
    await writeFile(foreign, 'pid 42\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(foreign, old, old);
    let settled = false;
    const pending = store.write(KEY, payload()).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    expect(await readFile(foreign, 'utf8')).toBe('pid 42\n');
    await rm(foreign);
    expect(await pending).toBeDefined();
  });

  it('knows when a stalled holder lost its lock, and leaves the successor\'s in place', async () => {
    const { directory } = await makeStore();
    const lock = path.join(directory, '.test.writing');
    await withFileLock(lock, async () => {
      expect(await holdsFileLock(lock)).toBe(true);
      // Taken over while this holder stalled past the stale age: the file there now is another writer's.
      await rm(lock);
      await writeFile(lock, LOCK_TOKEN, 'utf8');
      expect(await holdsFileLock(lock)).toBe(false);
    });
    expect(await readdir(directory)).toEqual(['.test.writing']);
  });

  it('lets one of several processes at a time take over a stale lock', async () => {
    const { directory } = await makeStore();
    const lock = path.join(directory, '.test.writing');
    await writeFile(lock, LOCK_TOKEN, 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    // Each process creates a marker while it holds the lock; a second holder at once fails to create it.
    const holder = `
      import { open, unlink } from 'node:fs/promises';
      import { withFileLock } from '@e2e-dev/core/lib/cache/file-lock';
      const marker = ${JSON.stringify(path.join(directory, 'held'))};
      await withFileLock(${JSON.stringify(lock)}, async () => {
        await (await open(marker, 'wx')).close();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await unlink(marker);
      });
    `;
    const codes = await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise<number | null>((resolve) => {
          spawn(process.execPath, ['--input-type=module', '-e', holder], { cwd: process.cwd(), stdio: 'ignore' }).on('exit', resolve);
        }),
      ),
    );
    expect(codes).toEqual([0, 0, 0, 0]);
  });

  it('takes over the empty lock of a writer that died before writing its token', async () => {
    const { directory, store } = await makeStore();
    const lock = path.join(directory, `.${NAME}.writing`);
    await writeFile(lock, '', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await store.write(KEY, payload())).toBeDefined();
    expect((await store.read(KEY, step())).status).toBe('hit');
  });

  it('replays a step whose act the YAML shows redacted', async () => {
    const { directory, store } = await makeStore();
    // The instruction as the entry keeps it differs from the one the key digested (a redacted secret, say).
    await store.write(KEY, payload('web', { recordedFor: step('web', { instruction: 'upgrade the plan to <secret:tier>' }) }));
    expect(await readFile(yamlPath(directory), 'utf8')).toContain('- act: upgrade the plan to <secret:tier>\n');
    expect((await store.read(KEY, step())).status).toBe('hit');
  });

  it('does not replay another step\'s recording under a key a lock edit pointed at it', async () => {
    const { directory, store } = await makeStore();
    const named = (instruction: string) => step('web', { instruction, instructionDigest: instructionDigest(instruction) });
    const [first, second] = [named('open the settings'), named('save the draft')];
    await store.write(KEY, payload('web', { recordedFor: first }));
    await store.write(OTHER_KEY, payload('web', { recordedFor: second, startPath: '/draft', endPath: '/draft' }));
    // A hand-resolved merge conflict in the lock, say: each key's line now names the other step's recording.
    const lock = JSON.parse(await readFile(lockPath(directory), 'utf8'));
    [lock.entries[0].digest, lock.entries[1].digest] = [lock.entries[1].digest, lock.entries[0].digest];
    await writeFile(lockPath(directory), JSON.stringify(lock), 'utf8');
    for (const [key, read] of [[KEY, first], [OTHER_KEY, second]] as const) {
      const result = await store.read(key, read);
      expect(result.status === 'invalid' && result.reason).toMatch(/its act is not the instruction its key was recorded for/u);
    }
  });

  it('finds each recording wherever its step moves, and reads one deleted from the YAML as absent', async () => {
    const { directory, store } = await makeStore();
    const named = (instruction: string) => step('web', { instruction, instructionDigest: instructionDigest(instruction) });
    const [first, second] = [named('open the cart'), named('check out')];
    await store.write(KEY, payload('web', { recordedFor: first }));
    await store.write(OTHER_KEY, payload('web', { recordedFor: second, startPath: '/checkout', endPath: '/checkout' }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    const at = yaml.indexOf('\n\n  - act: check out');
    const [head, firstStep, secondStep] = [yaml.slice(0, yaml.indexOf('  - act: open the cart')), yaml.slice(yaml.indexOf('  - act: open the cart'), at), yaml.slice(at + 2)];
    // Swapped, as a merge or a reviewer could leave them: each key keeps its own recording.
    await writeFile(yamlPath(directory), `${head}${secondStep}\n${firstStep}\n`, 'utf8');
    const swapped = [await store.read(KEY, first), await store.read(OTHER_KEY, second)];
    expect(swapped.map((read) => read.status === 'hit' && read.entry.payload.startPath)).toEqual(['/settings', '/checkout']);
    // Deleted from the YAML: that step is no longer recorded, and the other still replays.
    await writeFile(yamlPath(directory), `${head}${firstStep}\n`, 'utf8');
    expect((await store.read(OTHER_KEY, second)).status).toBe('miss');
    expect((await store.read(KEY, first)).status).toBe('hit');
    expect(await store.write('c'.repeat(64), payload('ios', { recordedFor: { ...first, targetId: 'ios' } }))).toBeDefined();
    expect(JSON.parse(await readFile(lockPath(directory), 'utf8')).entries).toHaveLength(2);
  });

  it('misses on an absent entry and rejects a malformed key hash', async () => {
    const { store } = await makeStore();
    expect((await store.read(KEY, step())).status).toBe('miss');
    expect((await store.read('../escape')).status).toBe('invalid');
    expect(await store.write('../escape', payload())).toBeUndefined();
  });

  it('does not write a trace that does not name its whole step', async () => {
    const { directory, store } = await makeStore();
    const { recordedFor: _recordedFor, ...anonymous } = payload();
    expect(await store.write(KEY, anonymous)).toBeUndefined();
    expect(await store.write(KEY, payload('web', { recordedFor: { testId: TEST_ID, targetId: 'web', instructionDigest: instructionDigest(INSTRUCTION) } }))).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  describe('fails closed on a file it cannot trust', () => {
    async function written() {
      const made = await makeStore({ maxBytes: 8_192 });
      await made.store.write(KEY, payload());
      return { ...made, yaml: await readFile(yamlPath(made.directory), 'utf8') };
    }

    it.each([
      ['a torn file', () => 'steps: [ torn'],
      ['an act edited under its key', (yaml: string) => yaml.replace('upgrade the plan to {tier}', 'downgrade the plan to {tier}')],
      ['params edited under their key', (yaml: string) => yaml.replace('tier: Pro', 'tier: Free')],
      ['an unknown key', (yaml: string) => yaml.replace('        at: /settings', '        at: /settings\n        later: true')],
      ['an unknown action', (yaml: string) => yaml.replace('          - back', '          - shell: rm -rf /')],
      ['an anchor and an alias', (yaml: string) => yaml.replace('- tap: { role: button', '- tap: &upgrade { role: button').replace('          - back', '          - tap: *upgrade')],
      ['a tag', (yaml: string) => yaml.replace('- type: Pro', '- type: !!str Pro')],
      ['a duplicate key', (yaml: string) => yaml.replace('        at: /settings', '        at: /settings\n        at: /elsewhere')],
      ['a target the lock does not name', (yaml: string) => yaml.replace('      web:', '      web2:')],
      ['a value the trace format refuses', (yaml: string) => yaml.replace('- press: Enter', '- press: ""')],
      ['an oversized file', (yaml: string) => `${yaml}#${'x'.repeat(9_000)}\n`],
    ])('%s', async (_label, edit) => {
      const { directory, store, yaml } = await written();
      await writeFile(yamlPath(directory), edit(yaml), 'utf8');
      const read = await store.read(KEY, step());
      expect(read.status).toBe('invalid');
    });

    it.each(['constructor', 'toString', '__proto__'])('an action named %s, an object built-in, as an unknown action', async (verb) => {
      const { directory, store, yaml } = await written();
      await writeFile(yamlPath(directory), yaml.replace('          - back', `          - ${verb}: x`), 'utf8');
      const read = await store.read(KEY, step());
      expect(read.status === 'invalid' ? read.reason : read.status).toContain(`has an unknown action "${verb}"`);
    });

    it('a missing lock file', async () => {
      const { directory, store } = await written();
      await rm(lockPath(directory));
      // Without the lock, nothing says which keys the YAML holds: a miss, never a replay.
      expect((await store.read(KEY, step())).status).not.toBe('hit');
    });

    it('a lock of another format', async () => {
      const { directory, store } = await written();
      const lock = JSON.parse(await readFile(lockPath(directory), 'utf8'));
      await writeFile(lockPath(directory), JSON.stringify({ ...lock, format: 'e2e-replay-lock-0' }), 'utf8');
      expect((await store.read(KEY, step())).status).not.toBe('hit');
    });

    it('and a later write or eviction leaves the file it could not read', async () => {
      const { directory, store, yaml } = await written();
      const torn = yaml.replace('steps:', 'steps: [ torn');
      await writeFile(yamlPath(directory), torn, 'utf8');
      expect(await store.write(KEY, payload())).toBeUndefined();
      await store.delete(KEY, step());
      expect(await readFile(yamlPath(directory), 'utf8')).toBe(torn);
    });

    it('a lock in a merge conflict, for every step of the test, without a second file', async () => {
      const { directory, store } = await written();
      const lock = await readFile(lockPath(directory), 'utf8');
      await writeFile(lockPath(directory), `<<<<<<< HEAD\n${lock}=======\n${lock}>>>>>>> branch\n`, 'utf8');
      expect((await store.read(KEY, step())).status).toBe('invalid');
      // A step the pair may or may not hold is no miss either: strict replay must not run it live.
      expect((await store.read(OTHER_KEY, step('web', { callIndex: 1 }))).status).toBe('invalid');
      expect(await store.write(OTHER_KEY, payload('web', { recordedFor: step('web', { callIndex: 1 }) }))).toBeUndefined();
      expect((await readdir(directory)).toSorted()).toEqual([`${NAME}.lock.json`, `${NAME}.yml`]);
    });

    it('but not a pair whose YAML names another test', async () => {
      const { directory, store } = await written();
      await rm(lockPath(directory));
      const otherTest = 'tests/settings.e2e.ts::settings::upgrades%20the%20plan!';
      expect((await store.read(OTHER_KEY, step('web', { testId: otherTest }))).status).toBe('miss');
    });
  });

  it('keeps a YAML recording no lock entry claims when another step records', async () => {
    const { directory, store } = await makeStore();
    const named = (instruction: string) => step('web', { instruction, instructionDigest: instructionDigest(instruction) });
    await store.write(KEY, payload('web', { recordedFor: named('open the cart') }));
    const lockBefore = await readFile(lockPath(directory), 'utf8');
    await store.write(OTHER_KEY, payload('web', { recordedFor: named('check out') }));
    // A write cut short after its YAML: the new step is in the YAML, not in the lock.
    await writeFile(lockPath(directory), lockBefore, 'utf8');
    const yaml = await readFile(yamlPath(directory), 'utf8');
    expect(await store.write('c'.repeat(64), payload('web', { recordedFor: named('pay') }))).toBeUndefined();
    expect(await readFile(yamlPath(directory), 'utf8')).toBe(yaml);
  });

  it('reads a lock whose YAML was deleted as holding nothing, and records over it', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await rm(yamlPath(directory));
    expect((await store.read(KEY, step())).status).toBe('miss');
    expect(await store.write(KEY, payload())).toBeDefined();
    expect((await store.read(KEY, step())).status).toBe('hit');
  });

  it('reads a YAML whose last step was deleted, leaving a bare steps key, as holding nothing', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    const yaml = await readFile(yamlPath(directory), 'utf8');
    await writeFile(yamlPath(directory), `${yaml.slice(0, yaml.indexOf('steps:'))}steps:\n`, 'utf8');
    expect((await store.read(KEY, step())).status).toBe('miss');
    expect(await store.write(OTHER_KEY, payload('ios'))).toBeDefined();
    expect((await store.read(OTHER_KEY, step('ios'))).status).toBe('hit');
    expect(JSON.parse(await readFile(lockPath(directory), 'utf8')).entries).toHaveLength(1);
  });

  describe('a writer killed between the two renames of a pair', () => {
    /** Records `trace` (by default a second recording) in a child process that kills itself as it renames onto a file ending `dies`. */
    async function killedWriter(directory: string, dies: string, key = OTHER_KEY, trace = payload('ios')): Promise<void> {
      const script = `
        import fsp from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const rename = fsp.rename;
        fsp.rename = (from, to) => {
          if (String(to).endsWith(${JSON.stringify(dies)})) {
            process.kill(process.pid, 'SIGKILL');
            return new Promise(() => undefined);
          }
          return rename(from, to);
        };
        syncBuiltinESMExports();
        const { FileCacheStore } = await import('@e2e-dev/core/lib/cache/store');
        const store = new FileCacheStore({ directory: ${JSON.stringify(directory)}, maxBytes: ${String(MAX_CACHE_WIRE_BYTES)}, writable: true });
        await store.write(${JSON.stringify(key)}, ${JSON.stringify(trace)});
      `;
      const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
        spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), stdio: 'ignore' }).on('exit', (_code, killedBy) => resolve(killedBy));
      });
      expect(signal).toBe('SIGKILL');
      // The dead writer's lock goes stale like any other.
      const stale = path.join(directory, `.${NAME}.writing`);
      const old = new Date(Date.now() - 60_000);
      await utimes(stale, old, old);
    }

    it('finishes publishing the new pair when the next run opens it', async () => {
      const { directory, store } = await makeStore();
      await store.write(KEY, payload());
      await killedWriter(directory, '.lock.json');
      // The new YAML sits beside the old lock: what a reader would take for an edit.
      expect(await readFile(yamlPath(directory), 'utf8')).toContain('ios:');
      expect(JSON.parse(await readFile(lockPath(directory), 'utf8')).entries).toHaveLength(1);
      expect((await store.read(OTHER_KEY, step('ios'))).status).toBe('hit');
      expect((await store.read(KEY, step())).status).toBe('hit');
      expect(JSON.parse(await readFile(lockPath(directory), 'utf8')).entries).toHaveLength(2);
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toEqual([]);
    });

    it('keeps the last complete pair when it died before replacing either file', async () => {
      const { directory, store } = await makeStore();
      await store.write(KEY, payload());
      await killedWriter(directory, '.yml');
      expect((await store.read(KEY, step())).status).toBe('hit');
      expect((await store.read(OTHER_KEY, step('ios'))).status).toBe('miss');
      expect(JSON.parse(await readFile(lockPath(directory), 'utf8')).entries).toHaveLength(1);
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toEqual([]);
      expect(await store.write(OTHER_KEY, payload('ios'))).toBeDefined();
    });

    it("finishes the pair of a test whose name collided, under that test's own name", async () => {
      const { directory, store } = await makeStore();
      const otherTest = 'tests/settings.e2e.ts::settings::upgrades%20the%20plan!';
      const other = (targetId: string): TraceProvenance => step(targetId, { testId: otherTest });
      const third = 'c'.repeat(64);
      await store.write(KEY, payload());
      await store.write(OTHER_KEY, payload('web', { recordedFor: other('web') }));
      await killedWriter(directory, '.lock.json', third, payload('ios', { recordedFor: other('ios') }));
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toHaveLength(1);
      expect((await store.read(third, other('ios'))).status).toBe('hit');
      expect((await store.read(OTHER_KEY, other('web'))).status).toBe('hit');
      expect((await store.read(KEY, step())).status).toBe('hit');
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toEqual([]);
    });

    // Root reads anything, and Windows ignores the mode: neither has a YAML it cannot open.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps the record while the YAML cannot be read, and finishes the pair once it can', async () => {
      const { directory, store } = await makeStore();
      await store.write(KEY, payload());
      await killedWriter(directory, '.lock.json');
      await chmod(yamlPath(directory), 0o000);
      try {
        expect((await store.read(OTHER_KEY, step('ios'))).status).not.toBe('hit');
        expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toHaveLength(1);
      } finally {
        await chmod(yamlPath(directory), 0o600);
      }
      expect((await store.read(OTHER_KEY, step('ios'))).status).toBe('hit');
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toEqual([]);
    });

    it('settles nothing when not writable, and reads the pair as it is', async () => {
      const { directory, store } = await makeStore();
      await store.write(KEY, payload());
      await killedWriter(directory, '.lock.json');
      const reader = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
      expect((await reader.read(OTHER_KEY, step('ios'))).status).toBe('miss');
      expect(JSON.parse(await readFile(lockPath(directory), 'utf8')).entries).toHaveLength(1);
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toHaveLength(1);
    });

    it('finishes the pair when publishing the lock failed and so did putting the old YAML back', async () => {
      const { directory, store } = await makeStore();
      await store.write(KEY, payload());
      // The lock's rename fails, and from then on so does every write: the rollback cannot restore the old YAML.
      const script = `
        import fsp from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const { rename, writeFile } = fsp;
        let full = false;
        const enospc = () => Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        fsp.rename = (from, to) => {
          if (String(to).endsWith('.lock.json')) {
            full = true;
            return Promise.reject(Object.assign(new Error('i/o error'), { code: 'EIO' }));
          }
          return rename(from, to);
        };
        fsp.writeFile = (...args) => (full ? Promise.reject(enospc()) : writeFile(...args));
        syncBuiltinESMExports();
        const { FileCacheStore } = await import('@e2e-dev/core/lib/cache/store');
        const store = new FileCacheStore({ directory: ${JSON.stringify(directory)}, maxBytes: ${String(MAX_CACHE_WIRE_BYTES)}, writable: true });
        await store.write(${JSON.stringify(OTHER_KEY)}, ${JSON.stringify(payload('ios'))}).then(() => process.exit(0), () => process.exit(3));
      `;
      const code = await new Promise<number | null>((resolve) => {
        spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), stdio: 'ignore' }).on('exit', resolve);
      });
      expect(code).toBe(3);
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toHaveLength(1);
      expect((await store.read(OTHER_KEY, step('ios'))).status).toBe('hit');
      expect((await store.read(KEY, step())).status).toBe('hit');
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toEqual([]);
    });

    it('leaves a pair a checkout replaced since the writer that left the record died', async () => {
      const { directory, store } = await makeStore();
      await store.write(KEY, payload());
      const written = await readFile(lockPath(directory), 'utf8');
      // Its writer died after both renames, before it removed its record.
      const sha = (text: string) => createHash('sha256').update(text).digest('hex');
      const record = { name: NAME, yamlDigest: sha(await readFile(yamlPath(directory), 'utf8')), lock: written, replaces: null };
      await writeFile(path.join(directory, `.${NAME}.pending`), JSON.stringify(record), 'utf8');
      // Another branch checked out: the same recording under another key.
      const branch = await makeStore();
      await branch.store.write(OTHER_KEY, payload());
      await writeFile(lockPath(directory), await readFile(lockPath(branch.directory), 'utf8'), 'utf8');
      const next = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
      expect((await next.read(OTHER_KEY, step())).status).toBe('hit');
      expect((await next.read(KEY, step())).status).toBe('miss');
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toEqual([]);
    });

    it('keeps the record, and the lock, while the lock there is too big to read', async () => {
      const { directory, store } = await makeStore();
      await store.write(KEY, payload());
      const sha = (text: string) => createHash('sha256').update(text).digest('hex');
      const record = { name: NAME, yamlDigest: sha(await readFile(yamlPath(directory), 'utf8')), lock: '{}', replaces: null };
      await writeFile(path.join(directory, `.${NAME}.pending`), JSON.stringify(record), 'utf8');
      // A checkout brought a lock over the cap this store reads.
      const big = `${await readFile(lockPath(directory), 'utf8')}${' '.repeat(20_000)}`;
      await writeFile(lockPath(directory), big, 'utf8');
      const capped = new FileCacheStore({ directory, maxBytes: 10_000, writable: true });
      expect((await capped.read(KEY, step())).status).toBe('invalid');
      expect(await readFile(lockPath(directory), 'utf8')).toBe(big);
      expect((await readdir(directory)).filter((name) => name.endsWith('.pending'))).toHaveLength(1);
    });

    it('leaves a file at the record path that is not a record a writer left', async () => {
      const { directory, store } = await makeStore();
      await store.write(KEY, payload());
      const foreign = path.join(directory, `.${NAME}.pending`);
      await writeFile(foreign, '{"upload":"queued"}', 'utf8');
      expect((await store.read(KEY, step())).status).toBe('hit');
      expect(await readFile(foreign, 'utf8')).toBe('{"upload":"queued"}');
    });
  });

  it('reads a step whose only target was deleted from the YAML as not recorded, and records it again', async () => {
    const { directory, store } = await makeStore();
    const second = step('web', { callIndex: 1 });
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { recordedFor: second, startPath: '/billing', endPath: '/billing' }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    // The first step's `web:` block goes, its `targets:` left bare.
    const start = yaml.indexOf('      web:');
    await writeFile(yamlPath(directory), `${yaml.slice(0, start)}${yaml.slice(yaml.indexOf('  - act:', start))}`, 'utf8');
    expect((await store.read(KEY, step())).status).toBe('miss');
    expect((await store.read(OTHER_KEY, second)).status).toBe('hit');
    expect(await store.write(KEY, payload())).toBeDefined();
    expect((await store.read(KEY, step())).status).toBe('hit');
  });

  it('fails an eviction it cannot write back, and the key still replays', async () => {
    const { directory, store } = await makeStore();
    const keys = Array.from({ length: 8 }, (_, index) => String(index).repeat(64));
    for (const [index, key] of keys.entries()) await store.write(key, payload('web', { recordedFor: step('web', { callIndex: index }) }));
    // The lock as compact JSON reads the same, but a rewrite renders it indented, over this store's cap.
    const lock = JSON.stringify(JSON.parse(await readFile(lockPath(directory), 'utf8')));
    await writeFile(lockPath(directory), lock, 'utf8');
    const capped = new FileCacheStore({ directory, maxBytes: Math.max(Buffer.byteLength(lock), Buffer.byteLength(await readFile(yamlPath(directory), 'utf8'))), writable: true });
    expect((await capped.read(keys[0]!, step())).status).toBe('hit');
    await expect(capped.delete(keys[0]!, step())).rejects.toThrow(/could not write/u);
    expect((await capped.read(keys[0]!, step())).status).toBe('hit');
  });

  it('keeps the lock entry of an edited step its own eviction cannot drop, so undoing the edit restores it', async () => {
    const { directory, store } = await makeStore();
    const second = step('web', { callIndex: 1 });
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { recordedFor: second, startPath: '/billing', endPath: '/billing' }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    await writeFile(yamlPath(directory), yaml.replace('at: /billing', 'at: /plans'), 'utf8');
    expect((await store.read(OTHER_KEY, second)).status).toBe('invalid');
    // The edited step ran live and its attempt failed: its own key is evicted.
    await store.delete(OTHER_KEY, second);
    await writeFile(yamlPath(directory), yaml, 'utf8');
    expect((await store.read(OTHER_KEY, second)).status).toBe('hit');
    expect(await store.write('c'.repeat(64), payload('ios'))).toBeDefined();
  });

  it('keeps a recording it cannot read when another is written or evicted beside it', async () => {
    const { directory, store } = await makeStore();
    const second = step('web', { callIndex: 1 });
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { recordedFor: second, startPath: '/billing', endPath: '/billing' }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    // The second step's act no longer matches its lock entry: that recording reads as invalid, the first still replays.
    const edited = `${yaml.slice(0, yaml.lastIndexOf('- act:'))}- act: downgrade the plan to {tier}\n${yaml.slice(yaml.indexOf('\n', yaml.lastIndexOf('- act:')) + 1)}`;
    await writeFile(yamlPath(directory), edited, 'utf8');
    expect((await store.read(OTHER_KEY, second)).status).toBe('invalid');
    expect((await store.read(KEY, step())).status).toBe('hit');
    expect(await store.write('c'.repeat(64), payload('ios'))).toBeUndefined();
    // Evicting the first leaves the YAML for a person to fix and drops the key from the lock alone: it no longer replays.
    await store.delete(KEY, step());
    expect(await readFile(yamlPath(directory), 'utf8')).toBe(edited);
    expect((await store.read(KEY, step())).status).toBe('miss');
    expect((await store.read(OTHER_KEY, second)).status).toBe('invalid');
    // Not even the edited step's own key rewrites it: the edited block is not known to be that step's.
    expect(await store.write(OTHER_KEY, payload('web', { recordedFor: second }))).toBeUndefined();
    expect(await readFile(yamlPath(directory), 'utf8')).toBe(edited);
  });

  // Root writes anywhere, and Windows ignores the mode: neither has a directory to refuse the lock.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reads from a directory it cannot write, as on a read-only mount', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await chmod(directory, 0o555);
    try {
      expect((await store.read(KEY, step())).status).toBe('hit');
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reads a pair it cannot open as invalid, never a miss, and does not list it', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await chmod(yamlPath(directory), 0o000);
    await chmod(lockPath(directory), 0o000);
    try {
      const read = await store.read(KEY, step());
      expect(read.status === 'invalid' && read.reason).toMatch(/unreadable/u);
      expect(await store.list()).toEqual([]);
    } finally {
      await chmod(yamlPath(directory), 0o600);
      await chmod(lockPath(directory), 0o600);
    }
    // Readable again: the same store reads it, not what it saw before.
    expect((await store.read(KEY, step())).status).toBe('hit');
  });

  it('refuses to write a file over its byte cap', async () => {
    const { store } = await makeStore({ maxBytes: 64 });
    expect(await store.write(KEY, payload())).toBeUndefined();
    expect((await store.read(KEY, step())).status).toBe('miss');
  });

  it('reads, even when not writable, only once a writer of the test is done', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    // Another process holds the test's lock, halfway through replacing its files.
    const held = path.join(directory, `.${NAME}.writing`);
    await writeFile(held, LOCK_TOKEN, 'utf8');
    const readOnly = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
    let settled = false;
    const pending = readOnly.read(KEY, step()).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    await rm(held);
    expect((await pending).status).toBe('hit');
  });

  it('lists without waiting on a lock beside files the store never wrote', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await writeFile(path.join(directory, 'aaa.yml'), 'on: push\n', 'utf8');
    await writeFile(path.join(directory, '.aaa.writing'), 'pid 42\n', 'utf8');
    const started = Date.now();
    expect((await store.list()).map((file) => file.name)).toEqual([NAME]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('lists a test only once a writer of it is done', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    const held = path.join(directory, `.${NAME}.writing`);
    await writeFile(held, LOCK_TOKEN, 'utf8');
    let settled = false;
    const pending = store.list().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    await rm(held);
    expect((await pending).map((file) => file.name)).toEqual([NAME]);
  });

  it('clears a pair under its test\'s lock, as it is once a writer is done', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    const held = path.join(directory, `.${NAME}.writing`);
    await writeFile(held, LOCK_TOKEN, 'utf8');
    const pending = store.clear(NAME);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The writer that held the lock finishes a new recording of the test before the clear goes ahead.
    await rm(held);
    expect(await pending).toBe(2);
    expect(await readdir(directory)).toEqual([]);
  });

  it('never writes when not writable', async () => {
    const { directory, store } = await makeStore({ writable: false });
    expect(await store.write(KEY, payload())).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it('evicts an entry on delete, tolerating absence and read-only mode', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await store.delete(KEY);
    expect(await readdir(directory)).toEqual([]);
    await store.delete(KEY);
    const readOnly = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
    await store.write(KEY, payload());
    await readOnly.delete(KEY, step());
    expect((await readdir(directory)).toSorted()).toEqual([`${NAME}.lock.json`, `${NAME}.yml`]);
  });
});
