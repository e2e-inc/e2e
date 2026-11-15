/**
 * Two users in one test, each on a simulator of its own: the test's own user
 * and a peer on the same target. The app keeps no shared state, so what the
 * test shows is that each user's steps, and each user's `device`, reach that
 * user's device and no other. Locator steps only, so it runs without a model.
 */

import type { Device } from '@e2e-dev/mobile';
import { expect, openScenario, test } from './fixtures.ts';

/** The simulators the run names for the iOS target, as `e2e.config.ts` reads them. */
const simulators = (process.env.E2E_MOBILE_BENCHMARK_IOS_DEVICE ?? '').split(',').filter((udid) => udid.trim() !== '').length;

// A peer takes a device of its own beside the worker's, so the scenario runs
// only where the run names two simulators, as CI does; a run with one would
// stop before its first test. Its peer takes the second simulator, so a run
// that holds it runs every other test on one worker: CI runs the suite with
// `--exclude-tag peers`, then this test alone with `--tag peers`. iOS only:
// CI's Android job has one emulator.
test.describe('two users', { tags: ['peers'], platforms: ['ios'], skip: simulators < 2 ? 'needs two simulators in E2E_MOBILE_BENCHMARK_IOS_DEVICE' : false }, () => {
  test('each user types on its own device, and each device fixture drives its own', { peers: { second: {} } }, async ({ app, device, screen, peers }) => {
    const second = { app: peers.second.app, device: peers.second.device as Device, screen: peers.second.screen };
    // Two devices, under two agent-device sessions.
    expect(second.device.unstable_raw.deviceId).not.toBe(device.unstable_raw.deviceId);
    expect(second.device.unstable_raw.session).not.toBe(device.unstable_raw.session);
    expect(peers.second.platform).toBe('ios');

    await openScenario({ app, device, screen }, 'Control Inventory');
    await openScenario(second, 'Control Inventory');

    // What one user types shows on its own screen only.
    await screen.getByRole('textbox', 'Name field').fill('Grace Hopper');
    await expect(screen.getByTestId('name-echo')).toHaveText('name: Grace Hopper');
    await expect(second.screen.getByTestId('name-echo')).toHaveText('name: Ada Lovelace');
    await second.screen.getByRole('textbox', 'Name field').fill('Alan Turing');
    await expect(second.screen.getByTestId('name-echo')).toHaveText('name: Alan Turing');
    await expect(screen.getByTestId('name-echo')).toHaveText('name: Grace Hopper');

    // Both act at once, each on its own device.
    const mine = `first ${Date.now()}`;
    const theirs = `second ${Date.now()}`;
    await Promise.all([device.setClipboard(mine), second.device.setClipboard(theirs)]);
    expect(await device.clipboard()).toBe(mine);
    expect(await second.device.clipboard()).toBe(theirs);

    // A device setting of one leaves the other's alone.
    try {
      await second.device.setAppearance('dark');
      await expect(second.screen.getByTestId('color-scheme')).toHaveText('scheme: dark');
      await expect(screen.getByTestId('color-scheme')).toHaveText('scheme: light');
    } finally {
      await second.device.setAppearance('light');
    }
  });
});
