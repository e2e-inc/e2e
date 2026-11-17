/**
 * An engine server process for the protocol tests: a toy engine served over
 * stdio, which reports what it received on stderr so a test can read it off
 * a failure message. `initializationOptions.crashOnObserve` makes `observe`
 * exit the process mid-request. With `closeStdoutFirst` it closes its stdout
 * 300 ms before it writes stderr and exits, and with `staysAfterStdout` it
 * closes its stdout and never exits. `hangDoctor` adds a `doctor` that logs the pid
 * and never returns, in a process that ignores SIGTERM.
 */

import { closeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { defineEngine, serveEngine } from '../../src/engine/index.ts';

await serveEngine((options) => {
  const { crashOnObserve: crash = false, closeStdoutFirst = false, staysAfterStdout = false, hangDoctor = false } = (options ?? {}) as {
    crashOnObserve?: boolean;
    closeStdoutFirst?: boolean;
    staysAfterStdout?: boolean;
    hangDoctor?: boolean;
  };
  return defineEngine({
    name: 'toy-server',
    version: '1.0.0',
    spiVersion: 1,
    platform: 'toy',
    actions: ['tap'],
    async observe() {
      if (crash) {
        if (closeStdoutFirst || staysAfterStdout) {
          closeSync(1);
          await delay(300);
        }
        if (staysAfterStdout) {
          process.stderr.write('toy server: stdout closed, staying\n');
          setInterval(() => {}, 1000);
          return new Promise(() => {});
        }
        process.stderr.write('toy server: crashing on purpose\n');
        process.exit(7);
      }
      return {
        root: { ref: { id: 'root', revision: '' }, role: 'root', children: [{ ref: { id: 'n1', revision: '' }, role: 'button', name: 'Save' }] },
        viewport: { width: 100, height: 100 },
        location: `pid:${String(process.pid)}`,
      };
    },
    async perform() {},
    async init(info) {
      info.log(`init slot ${String(info.workerSlot)}`);
    },
    ...(hangDoctor
      ? {
          async doctor(info) {
            process.on('SIGTERM', () => {});
            setInterval(() => {}, 1000);
            info.log(`pid:${String(process.pid)}`);
            return new Promise(() => {});
          },
        }
      : {}),
  });
});
