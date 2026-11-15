/**
 * The suite's `test`: the one `@e2e-dev/mobile` exports, typed with the
 * engine's contributed `device` fixture, plus the `build` fixture that puts
 * the app on the device. `expect` is `e2e`'s.
 */

import type { Device } from '@e2e-dev/mobile';
import { test as base } from '@e2e-dev/mobile';
import type { App, Screen } from 'e2e';
import { expect } from 'e2e';

export { expect } from 'e2e';

/** The build each platform's target runs against, when the run brings one; the config hands the same path to the target as `app.appPath`. */
const BUILDS: Readonly<Record<string, string | undefined>> = {
  ios: process.env.E2E_MOBILE_BENCHMARK_IOS_APP,
  android: process.env.E2E_MOBILE_BENCHMARK_ANDROID_APP,
};

/**
 * One install per worker, which is one per device: the promise is kept on
 * `globalThis` because the runner re-imports this module for every retry,
 * serial group, and setup test, so module state would start over with it.
 */
const INSTALLS = Symbol.for('e2e.mobile-benchmark.installs');
type Installs = Map<string, Promise<unknown>>;

function installs(): Installs {
  const holder = globalThis as { [INSTALLS]?: Installs };
  holder[INSTALLS] ??= new Map();
  return holder[INSTALLS];
}

/**
 * `build`: installs the platform's build on this worker's device before its
 * first test, and on the device of each peer a test declares, and nothing
 * when the run names none (the app is already on the device). The engine
 * installs nothing on its own, so this is where the suite says it; the step
 * shows in the first test's report.
 */
export const test = base.extend<{ build: undefined }>({
  build: async ({ device, platform, peers }, use) => {
    const pending = installs();
    const installOnce = async (key: string, on: Device, build: string): Promise<void> => {
      let install = pending.get(key);
      if (install === undefined) {
        install = on.installApp(build);
        pending.set(key, install);
      }
      await install;
    };
    const build = BUILDS[platform];
    if (build !== undefined) await installOnce(platform, device, build);
    // A peer on a device of its own needs the build there too; a peer on a
    // platform the run brings no build for (a browser) has no device to ask.
    // In this suite a peer's name is one device for the worker's whole life.
    for (const [name, peer] of Object.entries(peers)) {
      const peerBuild = BUILDS[peer.platform];
      if (peerBuild !== undefined) await installOnce(`${peer.platform} peer ${name}`, peer.device as Device, peerBuild);
    }
    await use(undefined);
  },
});

/**
 * Launches the app fresh, on its home list, and opens one scenario from it.
 * The list is two columns of compact rows with every scenario on screen
 * (`src/App.tsx`), so a scenario is one tap away and never scrolled to. A row is found by its label, "<name>. " and
 * the description: its test id is the name too, which the iOS navigation bar
 * takes as its identifier once the scenario is up. A scenario is up once its
 * row has left the tree (both platforms drop the list when a screen is
 * pushed; the home title stays on iOS as the back button's label) and its
 * own header shows the route name, on iOS in the navigation bar and on
 * Android in the toolbar; Bottom Tabs, the one route without a header, shows
 * its home tab instead. The tap gets one more try when the list swallowed it
 * or a neighbour opened, which is popped first. A sheet the scenario itself
 * presents on entry (Stripe's PaymentSheet, within the budget on a fast
 * runner) hides the header the same way; back dismisses it, and the scenario
 * is up once the header shows.
 */
export async function openScenario(
  { app, device, screen }: { app: App; device: Device; screen: Screen },
  name: string,
): Promise<void> {
  await app.open();
  const row = screen.getByLabel(`${name}. `, { exact: false });
  await expect(row).toBeVisible();
  const shown = name === 'Bottom Tabs' ? screen.getByTestId('home-tab-content') : screen.getByText(name);
  const opened = async (): Promise<boolean> => (await row.isHidden()) && (await shown.isVisible());
  await row.tap();
  // Ten seconds: a screen that boots a payment SDK takes a while to push on
  // a loaded CI Mac, and a pop in the middle of it leaves the list behind.
  try {
    await expect.poll(opened, { timeout: 10_000 }).toBe(true);
  } catch {
    if (await row.isHidden()) {
      await device.back();
      await expect.poll(async () => (await row.isVisible()) || (await opened()), { timeout: 5_000 }).toBe(true);
      if (await opened()) return;
    }
    await row.tap();
    await expect.poll(opened, { timeout: 10_000 }).toBe(true);
  }
}
