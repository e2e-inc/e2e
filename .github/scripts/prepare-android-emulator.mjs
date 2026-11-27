import { execFileSync } from 'node:child_process';

const [suite, serial] = process.argv.slice(2);
if (!['deterministic', 'agentic'].includes(suite) || !/^emulator-\d+$/.test(serial ?? '')) {
  throw new Error('Expected deterministic or agentic and an explicit emulator-<port> serial');
}

/** Runs only against the CI emulator, never adb's default device. */
function shell(...args) {
  return execFileSync('adb', ['-s', serial, 'shell', ...args], { encoding: 'utf8', timeout: 5000 });
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
  if (!['true', 'false'].includes(fields.showing) || fields.secure !== 'false') {
    throw new Error('Emulator keyguard is secure or has unknown state');
  }
  return fields;
}

shell('svc', 'power', 'stayon', 'true');
if (suite === 'deterministic') shell('locksettings', 'set-disabled', 'false');
shell('input', 'keyevent', 'KEYCODE_WAKEUP');
keyguard();
shell('wm', 'dismiss-keyguard');

// Dismissal is asynchronous. Observe it, but do not repeat the action or enter credentials.
const deadline = Date.now() + 5000;
while (true) {
  const state = keyguard();
  if (state.showing === 'false' && state.screenState === 'SCREEN_STATE_ON') break;
  if (Date.now() >= deadline) throw new Error('Emulator keyguard did not dismiss with the screen on');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
console.log(`Android emulator ${serial}: awake, non-secure keyguard dismissed`);
