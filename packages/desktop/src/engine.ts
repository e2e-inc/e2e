/**
 * The agent-desktop engine for e2e: a desktop body built with the public
 * `defineEngine`, validated by the same rules and graded by the same
 * capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `@e2e-dev/core/engine` and contributes the
 * `desktop` fixture the way the browser engine contributes `browser`.
 */

import { createRequire } from 'node:module';
import { ConfigurationError, defineEngine, type EngineAppCheckInfo, type EngineAppDeclaration, type EngineHandle, type LocatorActionKind, type PointerActionKind } from '@e2e-dev/core/engine';
import { createDesktopFixture } from './desktop.ts';
import type { DesktopFixtures } from './fixtures.ts';
import { hostPlatform, resolveOptions, type DesktopOptions, type DesktopPlatform } from './options.ts';
import { DesktopSurface } from './surface.ts';

/** What `perform` honors through the accessibility API alone. */
const ACTIONS: readonly LocatorActionKind[] = ['tap', 'secondaryTap', 'fill', 'clear', 'press', 'check', 'uncheck', 'focus', 'scrollIntoView', 'selectOption', 'swipe'];

/** What physical input adds: a double click and the pointer over a control (agent-desktop does both with the real pointer only), and taps at a point. */
const HEADED_ACTIONS: readonly LocatorActionKind[] = [...ACTIONS, 'doubleTap', 'hover'];
const HEADED_POINTER_ACTIONS: readonly PointerActionKind[] = ['tap', 'doubleTap', 'secondaryTap', 'hover'];

/**
 * Creates one desktop engine: it drives the target's app on this machine,
 * one worker at a time. A test launches the app with `app.open()`; every
 * test ends with the app quit.
 */
export function desktop(options: DesktopOptions = {}): EngineHandle<DesktopFixtures> {
  const resolved = resolveOptions(options);
  const platform = hostPlatform();
  if (platform === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `desktop() drives macOS, Windows, and Linux; this machine runs ${process.platform}`);
  }
  const surface = new DesktopSurface(resolved, platform);
  const headed = resolved.headed;
  return defineEngine<DesktopFixtures>({
    name: 'desktop',
    version: ownVersion(),
    spiVersion: 1,
    platform,
    workers: 1,
    prepare: (info) => surface.prepare(info),
    doctor: (info) => surface.doctor(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, observeOptions) => surface.observe(operation, observeOptions),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    actions: headed ? HEADED_ACTIONS : ACTIONS,
    ...(headed
      ? { performAt: (point, action, operation) => surface.performAt(point, action, operation), pointerActions: HEADED_POINTER_ACTIONS }
      : {}),
    // Typing into whatever has focus must send keystrokes, which agent-desktop does with physical input only.
    ...(headed
      ? {
          keyboard: {
            type: (text, keyboardOptions, operation) => surface.typeText(text, keyboardOptions, operation),
            press: (key, operation) => surface.pressKey(key, operation),
          },
        }
      : {}),
    validateApp: (app, info) => validateApp(app, info, platform),
    // No `open`: a desktop app has no URL, so the runner serves `app.open()`
    // with `restart`, a fresh launch of the target's app.
    session: {
      restart: (operation) => surface.restart(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
    },
    fixtures: {
      desktop: (context) => createDesktopFixture(surface, context),
    },
  });
}

/**
 * A desktop target launches an installed app: `bundleId` names it the way
 * agent-desktop's `launch` takes it (a bundle id or app name on macOS, an
 * app name elsewhere), or, on macOS, `appPath` names a built `.app` bundle.
 */
function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo, platform: DesktopPlatform): void {
  const where = `target "${targetName}"`;
  if (app.url !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.url, but a desktop() target drives an installed app; name it with app.bundleId${platform === 'macos' ? ' or app.appPath' : ''}`);
  }
  if (app.bundleId === undefined && app.appPath === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} needs ${platform === 'macos' ? "app.bundleId or app.appPath: desktop() launches an installed app, such as app: { bundleId: 'com.example.app' } or app: { appPath: 'build/Example.app' }" : "app.bundleId: desktop() launches an installed app by name, such as app: { bundleId: 'example' }"}`,
    );
  }
  if (app.appPath !== undefined) {
    if (platform !== 'macos') {
      throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.appPath, which desktop() launches on macOS only for now; on ${platform}, install the app and name it with app.bundleId`);
    }
    if (!/\.app\/?$/.test(app.appPath)) {
      throw new ConfigurationError('INVALID_CONFIG', `${where} app.appPath must name a macOS .app bundle, got ${JSON.stringify(app.appPath)}`);
    }
  }
  if (app.permissions !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.permissions, which a desktop() target cannot set`);
  }
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
