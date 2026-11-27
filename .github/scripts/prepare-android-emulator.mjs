import { execFileSync } from 'node:child_process';

const [suite, serial] = process.argv.slice(2);
let readinessDeadline;
if (!['deterministic', 'agentic'].includes(suite) || !/^emulator-\d+$/.test(serial ?? '')) {
  throw new Error('Expected deterministic or agentic and an explicit emulator-<port> serial');
}

/** Runs only against the CI emulator, never adb's default device. */
function shell(...args) {
  const remaining = readinessDeadline === undefined ? 5000 : readinessDeadline - Date.now();
  if (remaining <= 0) throw new Error('Emulator readiness exceeded five seconds');
  const output = execFileSync('adb', ['-s', serial, 'shell', ...args], { encoding: 'utf8', timeout: remaining });
  if (readinessDeadline !== undefined && Date.now() >= readinessDeadline) {
    throw new Error('Emulator readiness exceeded five seconds');
  }
  return output;
}

/** Reads API 36's KeyguardServiceDelegate block, rejecting missing or ambiguous state. */
function keyguard() {
  const dump = shell('dumpsys', 'window', 'policy');
  const blocks = [...dump.matchAll(/^([ \t]*)KeyguardServiceDelegate\r?\n((?:\1  [^\n]*\n?)*)/gm)];
  if (blocks.length !== 1) throw new Error('Cannot verify emulator keyguard state');
  const block = blocks[0][2];
  const fields = {};
  for (const name of ['showing', 'secure', 'screenState']) {
    const values = [...block.matchAll(new RegExp(`^\\s*${name}=(\\S+)\\s*$`, 'gm'))];
    if (values.length !== 1) throw new Error(`Cannot verify emulator keyguard ${name}`);
    fields[name] = values[0][1];
  }
  if (!['true', 'false'].includes(fields.showing) || !['true', 'false'].includes(fields.secure)) {
    throw new Error('Emulator keyguard has unknown state');
  }
  return fields;
}

shell('svc', 'power', 'stayon', 'true');
if (suite === 'deterministic') shell('locksettings', 'set-disabled', 'false');
shell('input', 'keyevent', 'KEYCODE_WAKEUP');
// Android starts with secure=true until its state is known. Observe before dismissal.
const deadline = Date.now() + 5000;
readinessDeadline = deadline;
let state = keyguard();
while (state.secure !== 'false') {
  if (Date.now() >= deadline) throw new Error('Emulator keyguard did not report non-secure state');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  state = keyguard();
}
shell('wm', 'dismiss-keyguard');

// Dismissal is asynchronous. Observe it, but do not repeat the action or enter credentials.
while (true) {
  state = keyguard();
  if (state.secure !== 'false') throw new Error('Emulator keyguard became secure during dismissal');
  if (state.showing === 'false' && state.screenState === 'SCREEN_STATE_ON') break;
  if (Date.now() >= deadline) throw new Error('Emulator keyguard did not dismiss with the screen on');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
console.log(`Android emulator ${serial}: awake, non-secure keyguard dismissed`);
