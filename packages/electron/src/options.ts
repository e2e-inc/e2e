/**
 * What the Electron engine is given: its options. The app under test is the
 * target's `app` (`appPath`, `launchArguments`); these options only say how
 * the engine starts Electron and reads its windows.
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError, rejectUnknownKeys, TestError } from '@e2e-dev/core/engine';

/** Variables no app is started with, whoever sets them, by their upper-case names. */
export const REFUSED_ENV: ReadonlySet<string> = new Set(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']);

/**
 * Options of the Electron engine. Every optional value also accepts
 * `undefined`, so values read straight from `process.env` need no
 * conditional spread.
 */
export interface ElectronOptions {
  /**
   * The executable to start: a packaged app's binary, or an Electron binary
   * of your own; relative to the project root. Default: the `electron`
   * package installed in the project, which runs the target's `app.appPath`.
   */
  readonly executablePath?: string | undefined;
  /**
   * Variables added to the app's environment. The app does not get the run's
   * environment, only what a process needs to start and draw (`PATH`,
   * `HOME`, the locale, the display): pass anything else it reads here.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** The directory the app's process starts in: absolute, or relative to the project root. Default: the project root. */
  readonly cwd?: string | undefined;
  /** The attribute `getByTestId` reads. Default `data-testid`. */
  readonly testIdAttribute?: string | undefined;
  /**
   * How long the engine waits after an action the agent took before the
   * agent observes again, in milliseconds; `false` skips the wait. A test's
   * own steps never wait: `expect` polls their outcome. Default 100.
   */
  readonly settle?: number | false | undefined;
}

const OPTION_KEYS = Object.keys({
  executablePath: true,
  env: true,
  cwd: true,
  testIdAttribute: true,
  settle: true,
} satisfies Record<keyof ElectronOptions, true>);

/** The options with defaults applied, checked once at config load. */
export interface ResolvedElectronOptions {
  readonly executablePath?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly testIdAttribute: string;
  readonly settleMs: number;
}

/**
 * Why the engine refuses a launch argument it owns, or undefined: Chromium's
 * profile directory (every attempt gets an empty one), and the inspector and
 * the DevTools transport the engine drives the app through (a fixed port
 * would also collide between workers).
 */
export function ownedArgument(argument: string): string | undefined {
  if (/^--user-data-dir(=|$)/.test(argument)) return 'must not set --user-data-dir: the engine gives every attempt an empty one of its own';
  const port = /^(--inspect(-brk)?|--remote-debugging-port|--remote-debugging-pipe)(=|$)/.exec(argument);
  if (port !== null) return `must not set ${port[1]}: the engine opens the inspector and the DevTools pipe it drives the app through itself`;
  return undefined;
}

/** Checks the target's `app.launchArguments`: the app's own switches and Chromium's, none of the engine's. */
export function checkLaunchArguments(launchArguments: readonly string[] | undefined): void {
  const owned = launchArguments?.map(ownedArgument).find((reason) => reason !== undefined);
  if (owned !== undefined) throw new ConfigurationError('INVALID_CONFIG', `app.launchArguments ${owned}`);
}

const DEFAULT_SETTLE_MS = 100;

/**
 * An attribute name the document grammar accepts (XML `Name`, ASCII): a value
 * outside it could never be on an element, so `getByTestId` would match
 * nothing and every `testId` query would fail silently.
 */
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

/** Checks the option bag the way every config option is checked: unknown keys and wrong types fail the config load. */
export function resolveOptions(options: ElectronOptions | undefined): ResolvedElectronOptions {
  // Only a missing bag defaults: a null one (from JSON an agent wrote for e2e mcp) is a config error, not the defaults.
  const bag: ElectronOptions = options === undefined ? {} : options;
  if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) throw new ConfigurationError('INVALID_CONFIG', 'electron() options must be an object');
  rejectUnknownKeys('electron() options', bag, OPTION_KEYS);
  const { executablePath, env, cwd, testIdAttribute, settle } = bag;
  if (executablePath !== undefined && (typeof executablePath !== 'string' || executablePath === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ executablePath }) must be a path to an executable');
  }
  checkEnv('electron({ env })', env, 'INVALID_CONFIG');
  checkCwdShape('electron({ cwd })', cwd, 'INVALID_CONFIG');
  if (testIdAttribute !== undefined && (typeof testIdAttribute !== 'string' || !ATTRIBUTE_NAME.test(testIdAttribute))) {
    throw new ConfigurationError('INVALID_CONFIG', `electron({ testIdAttribute }) must be an attribute name such as "data-testid", got ${JSON.stringify(testIdAttribute)}`);
  }
  if (settle !== undefined && settle !== false && (!Number.isInteger(settle) || settle < 0)) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ settle }) must be a whole number of milliseconds, or false');
  }
  return {
    ...(executablePath === undefined ? {} : { executablePath }),
    env: env ?? {},
    ...(cwd === undefined ? {} : { cwd }),
    testIdAttribute: testIdAttribute ?? 'data-testid',
    settleMs: settle === false ? 0 : (settle ?? DEFAULT_SETTLE_MS),
  };
}

type RefusalCode = 'INVALID_CONFIG' | 'INVALID_ARGUMENT';

/** A config's mistake is a configuration error; a test's call with the same mistake is the test's. */
function refusal(code: RefusalCode, message: string): Error {
  return code === 'INVALID_CONFIG' ? new ConfigurationError(code, message) : new TestError(code, message);
}

/** Checks variables for the app's environment: names to strings, none of the ones no app is started with. */
function checkEnv(label: string, env: unknown, code: RefusalCode): asserts env is Readonly<Record<string, string>> | undefined {
  if (env === undefined) return;
  if (typeof env !== 'object' || env === null || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string')) {
    throw refusal(code, `${label} must be an object of variable name to string value`);
  }
  // Windows reads a variable's name in any case.
  const refused = Object.keys(env).find((name) => REFUSED_ENV.has(name.toUpperCase()));
  if (refused !== undefined) {
    throw refusal(code, `${label} must not set ${refused}: ${refused.toUpperCase() === 'NODE_OPTIONS' ? 'the engine starts the app with its own Node.js switches' : 'it starts the binary as plain Node.js, which opens no window'}`);
  }
}

function checkCwdShape(label: string, cwd: unknown, code: RefusalCode): asserts cwd is string | undefined {
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '')) throw refusal(code, `${label} must be a path to a directory`);
}

/** Checks that `cwd` names a directory a process can start in, from the project root. */
export function checkCwd(label: string, projectRoot: string, cwd: string | undefined, code: RefusalCode): void {
  if (cwd === undefined) return;
  const resolved = path.resolve(projectRoot, cwd);
  if (statSync(resolved, { throwIfNoEntry: false })?.isDirectory() !== true) throw refusal(code, `${label} names ${resolved}, which is not a directory`);
}

const LAUNCH_KEYS = ['launchArguments', 'env', 'cwd', 'timeout'];

/** What `electron.launch()` was given, checked: the arguments, variables, and directory one test adds to its launches. */
export function checkLaunchOptions(options: unknown, projectRoot: string): { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd?: string } {
  const label = 'electron.launch()';
  if (options === undefined) return { args: [], env: {} };
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw refusal('INVALID_ARGUMENT', `${label} takes an object of options`);
  rejectUnknownKeys(`${label} options`, options, LAUNCH_KEYS, 'INVALID_ARGUMENT');
  const { launchArguments: args = [], env, cwd } = options as { readonly launchArguments?: unknown; readonly env?: unknown; readonly cwd?: unknown };
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) throw refusal('INVALID_ARGUMENT', 'electron.launch({ launchArguments }) must be a list of strings');
  const owned = (args as string[]).map(ownedArgument).find((reason) => reason !== undefined);
  if (owned !== undefined) throw refusal('INVALID_ARGUMENT', `electron.launch({ launchArguments }) ${owned}`);
  checkEnv('electron.launch({ env })', env, 'INVALID_ARGUMENT');
  checkCwdShape('electron.launch({ cwd })', cwd, 'INVALID_ARGUMENT');
  checkCwd('electron.launch({ cwd })', projectRoot, cwd, 'INVALID_ARGUMENT');
  return { args: [...(args as string[])], env: { ...env }, ...(cwd === undefined ? {} : { cwd }) };
}
