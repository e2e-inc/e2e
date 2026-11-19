/**
 * What the desktop engine is given: its options, and the platform it runs on.
 * The app under test is the target's `app` (`bundleId`, `appPath`,
 * `launchArguments`); these options only say how agent-desktop drives it.
 */

import { ConfigurationError, rejectUnknownKeys } from '@e2e-dev/core/engine';

/** The desktop operating systems agent-desktop drives, as the engine's platform label. */
export type DesktopPlatform = 'macos' | 'windows' | 'linux';

/**
 * Options of the desktop engine. Every optional value also accepts
 * `undefined`, so values read straight from `process.env` need no
 * conditional spread.
 */
export interface DesktopOptions {
  /**
   * Path to an agent-desktop executable to use instead of the pinned release
   * the engine downloads on the first run. The executable's helper (on macOS
   * `agent-desktop-macos-helper`) must sit beside it, as in a release archive
   * or a Homebrew install.
   */
  readonly binary?: string | undefined;
  /**
   * What an observation captures. `full` (default) includes static text, so
   * judgments and `toHaveText` can read labels; `interactive` keeps only the
   * controls agent-desktop gives a ref.
   */
  readonly snapshot?: 'full' | 'interactive' | undefined;
  /**
   * Allows physical input: the real pointer and keyboard, which take focus
   * and move the cursor. Off by default: every action goes through the
   * accessibility API and leaves the user's pointer and focus alone (only
   * `app.open()` brings the app forward). On, the
   * engine also offers `doubleTap`, `hover`, point-addressed taps, and keystrokes into whatever has focus (the keyboard capability), and falls back to
   * typing a field the accessibility API cannot set (Electron text fields on
   * Linux).
   */
  readonly headed?: boolean | undefined;
  /**
   * How long the engine waits after an action the agent took before the agent
   * observes again, in milliseconds; `false` skips the wait. A test's own
   * steps never wait: `expect` polls their outcome. Default 150.
   */
  readonly settle?: number | false | undefined;
}

const OPTION_KEYS = Object.keys({ binary: true, snapshot: true, headed: true, settle: true } satisfies Record<keyof DesktopOptions, true>);

/** The options with defaults applied, checked once at config load. */
export interface ResolvedDesktopOptions {
  readonly binary?: string;
  readonly interactiveOnly: boolean;
  readonly headed: boolean;
  readonly settleMs: number;
}

const DEFAULT_SETTLE_MS = 150;

/** Checks the option bag the way every config option is checked: unknown keys and wrong types fail the config load. */
export function resolveOptions(options: DesktopOptions | undefined): ResolvedDesktopOptions {
  const bag: DesktopOptions = options ?? {};
  if (typeof bag !== 'object' || bag === null) throw new ConfigurationError('INVALID_CONFIG', 'desktop() options must be an object');
  rejectUnknownKeys('desktop() options', bag, OPTION_KEYS);
  const { binary, snapshot, headed, settle } = bag;
  if (binary !== undefined && (typeof binary !== 'string' || binary === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'desktop({ binary }) must be a path to an agent-desktop executable');
  }
  if (snapshot !== undefined && snapshot !== 'full' && snapshot !== 'interactive') {
    throw new ConfigurationError('INVALID_CONFIG', `desktop({ snapshot }) must be 'full' or 'interactive', got ${JSON.stringify(snapshot)}`);
  }
  if (headed !== undefined && typeof headed !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', 'desktop({ headed }) must be a boolean');
  }
  if (settle !== undefined && settle !== false && (!Number.isInteger(settle) || settle < 0)) {
    throw new ConfigurationError('INVALID_CONFIG', 'desktop({ settle }) must be a whole number of milliseconds, or false');
  }
  return {
    ...(binary === undefined ? {} : { binary }),
    interactiveOnly: snapshot === 'interactive',
    headed: headed === true,
    settleMs: settle === false ? 0 : (settle ?? DEFAULT_SETTLE_MS),
  };
}

/** The platform label of the machine the engine runs on; another OS cannot be driven at all. */
export function hostPlatform(): DesktopPlatform | undefined {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return undefined;
  }
}
