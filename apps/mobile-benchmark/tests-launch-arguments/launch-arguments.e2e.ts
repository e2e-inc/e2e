/**
 * Reads the launch the engine made from outside the app, since the benchmark
 * app reads no launch argument itself: the simulator app's process arguments
 * on the host, and the emulator's launch intent through `adb`. Local
 * simulator and emulator only.
 */

import { execFileSync } from 'node:child_process';
import { expect, test } from '../tests/fixtures.ts';

const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const ADB = SDK === undefined ? 'adb' : `${SDK}/platform-tools/adb`;

test('the app launches with the target launch arguments', async ({ app, device, screen, platform }) => {
  await app.open();
  await expect(screen.getByLabel('Permission Prompt. ', { exact: false })).toBeVisible();
  const { deviceId } = device.unstable_raw;
  if (platform === 'ios') {
    const appProcess = execFileSync('ps', ['-axo', 'args'], { encoding: 'utf8' })
      .split('\n')
      .find((entry) => entry.includes(`/Devices/${deviceId}/`) && entry.includes('e2eBenchmark.app/e2eBenchmark'));
    expect(appProcess).toContain('e2eBenchmark -AppleLanguages (fr) -AppleLocale fr_FR');
  } else {
    // dumpsys prints `(has extras)` and never an extra's name or value.
    const launchIntent = execFileSync(ADB, ['-s', deviceId, 'shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' })
      .split('\n')
      .find((entry) => entry.includes('Intent {') && entry.includes('dev.e2e.benchmark/.MainActivity'));
    expect(launchIntent).toContain('(has extras)');
  }
});
