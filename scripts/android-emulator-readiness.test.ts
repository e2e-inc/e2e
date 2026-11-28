import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/mobile.yml', import.meta.url), 'utf8');
const prep = workflow.slice(workflow.indexOf('profile: pixel_7')).match(/script: \|\n\s+([^\n]+)/)?.[1];
assert.ok(prep);

/** Runs the workflow's real preparation command against an isolated stateful adb. */
function run(t: TestContext, mode = 'normal', suite = 'deterministic') {
  const dir = mkdtempSync(join(tmpdir(), 'android-readiness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, 'state.json');
  const calls = join(dir, 'calls.txt');
  writeFileSync(calls, '');
  writeFileSync(state, JSON.stringify({ showing: false, swipe: false, reads: 0 }));
  const adb = join(dir, 'adb');
  writeFileSync(adb, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args[0] === '-s' ? args.slice(2).join(' ') : args.join(' ');
fs.appendFileSync(process.env.CALLS, args.join(' ') + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.STATE));
if (command === 'shell locksettings set-disabled false') { state.swipe = true; state.showing = true; }
if (command === 'shell wm dismiss-keyguard' && process.env.MODE !== 'locked') state.showing = false;
if (command === 'shell dumpsys window policy') {
  if (process.env.MODE === 'adb-failure') process.exit(1);
  state.reads++;
  const secure = process.env.MODE === 'secure' || (process.env.MODE === 'settling' && state.reads < 3);
  const block = '\\n  KeyguardServiceDelegate\\n    showing=' + state.showing + '\\n    secure=' + secure + '\\n    screenState=SCREEN_STATE_ON\\n';
  console.log(process.env.MODE === 'unknown' ? 'no keyguard state' : process.env.MODE === 'ambiguous' ? block + block : block);
}
fs.writeFileSync(process.env.STATE, JSON.stringify(state));
`);
  chmodSync(adb, 0o755);
  const clock = join(dir, 'clock.cjs');
  writeFileSync(clock, 'let calls = 0; Date.now = () => calls++ < 2 ? 0 : 5001;');
  const command = prep!.replaceAll('${{ matrix.suite }}', suite).replace('emulator-5554', mode === 'physical' ? 'physical-device' : 'emulator-5554');
  const result = spawnSync('sh', ['-c', `${command} && printf suite-started`], {
    cwd: join(root, 'apps/mobile-benchmark'), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STATE: state, CALLS: calls, MODE: mode, ...(mode === 'budget-expired' ? { NODE_OPTIONS: `--require ${clock}` } : {}) },
  });
  return { result, state: JSON.parse(readFileSync(state, 'utf8')), calls: readFileSync(calls, 'utf8') };
}

test('workflow dismisses the keyguard raised by enabling Swipe before starting the suite', (t) => {
  const { result, state, calls } = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.swipe, true, 'the lock test still needs Swipe');
  assert.equal(state.showing, false, 'the suite must not start behind keyguard');
  assert.match(result.stdout, /suite-started/);
  assert.ok(calls.indexOf('set-disabled false') < calls.indexOf('wm dismiss-keyguard'));
  assert.match(calls, /input keyevent KEYCODE_WAKEUP/);
  assert.ok(calls.trim().split('\n').every((line) => line.startsWith('-s emulator-5554 ')));
});

for (const mode of ['locked', 'secure', 'unknown', 'ambiguous', 'adb-failure']) {
  test(`workflow refuses to start the suite when keyguard is ${mode}`, (t) => {
    const { result, calls } = run(t, mode);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /suite-started/);
    assert.ok(calls.split('wm dismiss-keyguard').length <= 2, 'dismissal must not be retried');
    if (mode === 'secure') assert.doesNotMatch(calls, /wm dismiss-keyguard/);
  });
}

test('agentic preparation does not enable Swipe', (t) => {
  const { result, state } = run(t, 'normal', 'agentic');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.swipe, false);
});

test('preparation observes non-secure state before its single dismissal', (t) => {
  const { result, calls } = run(t, 'settling');
  assert.equal(result.status, 0, result.stderr);
  const beforeDismiss = calls.slice(0, calls.indexOf('wm dismiss-keyguard'));
  assert.equal(beforeDismiss.split('dumpsys window policy').length - 1, 3);
  assert.equal(calls.split('wm dismiss-keyguard').length - 1, 1);
});

test('preparation rejects a physical serial before any adb side effect', (t) => {
  const { result, calls } = run(t, 'physical');
  assert.notEqual(result.status, 0);
  assert.equal(calls, '');
  assert.doesNotMatch(result.stdout, /suite-started/);
});

test('preparation does not dismiss when a non-secure read returns after the budget', (t) => {
  const { result, calls } = run(t, 'budget-expired');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /readiness exceeded five seconds/);
  assert.doesNotMatch(calls, /wm dismiss-keyguard/);
  assert.doesNotMatch(result.stdout, /suite-started/);
});
