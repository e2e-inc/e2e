# @e2e-dev/electron

The Electron engine for [`e2e`](https://www.npmjs.com/package/e2e): an
Electron app's windows, read through Chromium's accessibility tree over the
DevTools protocol and driven with trusted input, through the same
`@e2e-dev/core/engine` contract the browser, mobile, and desktop engines
implement. A test written against `screen`, `expect`, `app`, and `agent` runs
on an Electron target unchanged.

It is also the reference for an engine built outside this repository: it
imports only `@e2e-dev/core/engine` and speaks the DevTools protocol itself,
with no automation library and never another engine. [Engines](https://e2e.com/docs/engines) lists what
building it changed in the contract.

## Install

```bash
npm install --save-dev e2e @e2e-dev/electron electron
```

The engine starts the `electron` package installed in the project, and
downloads its binary one time per run when it is missing. Run
`npx e2e doctor` to check.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { electron } from '@e2e-dev/electron';

export default {
  targets: [{ name: 'electron', engine: electron(), app: { appPath: '.' } }],
} satisfies E2EConfig;
```

`app.appPath` is the app's directory or main script, and `app.launchArguments`
go after it on every launch. For a packaged app, pass
`electron({ executablePath })` and leave out `appPath`.

```ts title="tests/sign-in.e2e.ts"
import { test } from '@e2e-dev/electron';
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

- **Launch.** `app.open()` starts the app on an empty user-data directory and
  waits for a window to load. Every test ends with the app quit.
- **Read.** Chromium's accessibility tree joined with one DOM snapshot.
  Nothing runs in the app's page to read it.
- **Act.** Trusted mouse and keyboard input, once the node is enabled, on
  screen, and topmost at its point.
- **Windows.** The agent sees them as tabs. The `electron` fixture has
  `evaluate` (main process), `windows`, `useWindow`, and `locator` (CSS).
- **Secrets.** Password fields report no value, and screenshots paint them
  and nested documents over.

## Not supported yet

| What | Why | Instead |
| --- | --- | --- |
| `prompt()` | Electron does not implement it | Build the prompt in the page |
| In-memory uploads | The DevTools protocol sets a file input from paths only | Write the file to disk and pass its path |
| Content inside an `iframe` or `webview` | The engine reads the window's own document; a nested one is a separate target it does not attach to yet | A `webview` guest is listed as a window: `electron.useWindow()` |
| Routes and cookies | They are the browser engine's `browser` fixture, and an Electron app has one session per partition | `session.defaultSession` in `electron.evaluate` |
| Waiting for a download | The engine places downloads but reports no download events | Read the `downloads` directory in `electron.evaluate` |
| `app.back()` | The app loads its own pages, so the engine does not navigate | Navigate from `electron.evaluate` |
| Video | No recorder is built | `app.screenshot()` |
| Session save and restore, `toBeInViewport`, computed-style reads | Not built | |

[The Electron guide](https://e2e.com/docs/electron) lists every difference
from the web.

## License

Apache-2.0
