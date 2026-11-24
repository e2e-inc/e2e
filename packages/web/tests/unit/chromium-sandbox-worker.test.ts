/** The worker's browser hands its launch the `chromiumSandbox` option, or the platform default without one. */
import type { Browser } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultChromiumSandbox } from '../../src/browser-connection.ts';
import type { WebOptions } from '../../src/surface.ts';
import type { WorkerBrowser } from '../../src/worker-browser.ts';
import { cleanupContext, openWorker } from '../helpers/attempt.ts';

const acquire = vi.hoisted(() => vi.fn());
vi.mock('../../src/browser-connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/browser-connection.ts')>()),
  BrowserConnection: class {
    acquire = acquire;
    dispose = async () => undefined;
  },
}));

let workers: WorkerBrowser[] = [];

async function launchedSandbox(options: WebOptions): Promise<unknown> {
  acquire.mockReset();
  acquire.mockResolvedValue({} as unknown as Browser);
  workers.push(await openWorker({ options }));
  expect(acquire).toHaveBeenCalledOnce();
  return (acquire.mock.calls[0]![0] as { chromiumSandbox: unknown }).chromiumSandbox;
}

afterEach(async () => {
  for (const worker of workers) await worker.dispose(cleanupContext());
  workers = [];
});

it('launches with the platform default when the option is omitted', async () => {
  await expect(launchedSandbox({})).resolves.toBe(defaultChromiumSandbox());
});

it('launches with what the option says', async () => {
  await expect(launchedSandbox({ chromiumSandbox: false })).resolves.toBe(false);
  await expect(launchedSandbox({ chromiumSandbox: true })).resolves.toBe(true);
});
