/**
 * One process for the many-waiters test: at the time in argv[4] it takes the
 * refresh lock of the store at argv[2] and writes `+pid` when it enters and
 * `-pid` when it leaves to the log at argv[3].
 */

import { appendFileSync } from 'node:fs';
import { FileCredentialStore } from '../../../../src/oauth/store.ts';

const [file, log, startAt] = process.argv.slice(2) as [string, string, string];

// Spin rather than sleep: timers wake each process at a slightly different time, and the race needs them together.
while (Date.now() < Number(startAt));
await new FileCredentialStore(file).exclusive('test', async () => {
  appendFileSync(log, `+${process.pid}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  appendFileSync(log, `-${process.pid}\n`);
});
