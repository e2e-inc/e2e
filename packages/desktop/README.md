# @e2e-dev/desktop

The desktop engine for [`e2e`](https://www.npmjs.com/package/e2e), built on
[agent-desktop](https://github.com/vercel-labs/agent-desktop): native and
Electron apps, read and driven through the OS accessibility tree (AX on
macOS, UI Automation on Windows, AT-SPI on Linux), through the same
`@e2e-dev/core/engine` contract the browser and mobile engines implement. A
test written against `screen`, `expect`, `app`, and `agent` runs on a desktop
target unchanged.

> [!NOTE]
> This is a prototype. macOS is the platform it is tested on; Windows and
> Linux run through the same commands but are not tested yet.

## Install

```bash
npm install --save-dev e2e @e2e-dev/desktop
```

The engine downloads its pinned agent-desktop release on the first run and
checks it against its SHA-256 digest. To use an install of your own (Homebrew,
a CI image), pass `desktop({ binary: '/path/to/agent-desktop' })`.

On macOS, the app that starts e2e (your terminal, IDE, or CI agent) needs
Accessibility permission, and Screen Recording for screenshots, in System
Settings > Privacy & Security. Run `npx e2e doctor` to check.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { desktop } from '@e2e-dev/desktop';

export default {
  targets: [{ name: 'mac', engine: desktop(), app: { appPath: 'build/MyApp.app' } }],
} satisfies E2EConfig;
```

`app.bundleId` names an installed app instead (`'com.apple.TextEdit'`, or an
app name), and `app.launchArguments` are passed to every launch.

```ts title="tests/sign-in.e2e.ts"
import { test } from '@e2e-dev/desktop';
import { credentials, expect } from 'e2e';

test('signs in', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('textbox', 'Username').fill('ada');
  await screen.getByRole('textbox', 'Password').fill(credentials.user('ada').password);
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByTestId('status')).toContainText('Signed in');
});
```

## How it works

- `app.open()` launches the app fresh, after quitting the copy the engine
  launched before. A copy you opened yourself is never read, driven, or quit.
  Every test ends with the app quit.
- An observation is one agent-desktop snapshot of the app's window. Roles map
  onto the ARIA names other engines use (`textbox`, `checkbox`, `combobox`,
  `button`); the developer id (`AXIdentifier`, `AutomationId`, a DOM `id` in
  Electron) is the node's test id, so `getByTestId` finds it.
- Actions go through the accessibility API and leave your pointer and focus
  alone. `desktop({ headed: true })` allows physical input: `doubleTap`,
  `hover`, point-addressed taps, and typing into fields the API cannot set.
- A fill sends the text to agent-desktop on stdin, never in its arguments.
  A secure field reports no value, and screenshots paint over its bounds; when
  a secure field has no bounds, the screenshot is withheld.
- One worker per target: its workers would share one screen. Two desktop
  targets can still run at the same time; with `headed: true`, set the run's
  `workers: 1`.

## License

Apache-2.0
