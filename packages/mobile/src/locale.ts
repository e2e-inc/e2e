/**
 * The language and region an app is launched in: `app.locale` and
 * `device.openApp({ locale })`. iOS reads it from the launch's process
 * arguments, as `NSUserDefaults` does for `AppleLanguages` and `AppleLocale`,
 * so it holds for that launch only, on any device agent-device launches.
 * Android has no such argument: the engine sets the app's own locale
 * (Android 13's per-app language) through this machine's `adb` before the
 * launch, so it works on an emulator or phone this machine reaches, and a
 * device a provider leased is refused.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ConfigurationError, EngineError, TestError, appleUserDefaults, type ResolvedLaunchArguments } from '@e2e-dev/core/engine';
import type { MobileOptions, MobilePlatform } from './options.ts';
import { isDeviceList } from './pool.ts';
import type { DeviceProvider } from './provider.ts';
import { unsupported } from './support.ts';

type Code = 'INVALID_CONFIG' | 'INVALID_ARGUMENT';

/** The Apple arguments `locale` writes, which a launch must not carry beside it. */
const APPLE_LOCALE_ARGUMENTS = ['AppleLanguages', 'AppleLocale'] as const;

/** The first Android release with per-app languages, `cmd locale set-app-locales`. */
const MIN_ANDROID_SDK = 33;

/** What one `adb` invocation printed and how it exited. */
export interface AdbResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Runs `adb` with `args`; the seam unit tests script. `env` is the run's environment, where the Android SDK is looked up. */
export type AdbRunner = (args: readonly string[], env: Readonly<Record<string, string | undefined>>, signal: AbortSignal) => Promise<AdbResult>;

/**
 * A locale a device launch takes: a BCP 47 tag of a language, with a script
 * and a region when given, and no extension (`-u-ca-japanese`), which
 * neither `AppleLocale` nor every Android release reads the same way.
 * Returns the tag in its canonical case. `INVALID_CONFIG` for a target's
 * `app.locale`, `INVALID_ARGUMENT` for `device.openApp({ locale })`.
 */
export function checkLocale(label: string, value: unknown, code: Code): string {
  let locale: Intl.Locale | undefined;
  try {
    locale = typeof value === 'string' ? new Intl.Locale(value) : undefined;
  } catch {
    locale = undefined;
  }
  // Node 22 and 24 report `und` as no language at all; Node 26 as `und`.
  if (locale === undefined || locale.language === undefined || locale.language === 'und') {
    fail(code, `${label} must be a BCP 47 language tag such as "fr-FR", got ${JSON.stringify(value)}`);
  }
  // `baseName` keeps a variant (`ca-ES-valencia`), which `AppleLocale` has no place for.
  const { language, script, region } = locale;
  const tag = [language, script, region].filter((part) => part !== undefined).join('-');
  if (locale.toString() !== tag) {
    fail(code, `${label} takes a language, script, and region only, such as "fr-FR" or "zh-Hans-CN", got ${JSON.stringify(value)}`);
  }
  return tag;
}

/**
 * Refuses a locale beside launch arguments that set the same Apple defaults
 * (`AppleLanguages`, `AppleLocale`) as an object key or a `-name` list item:
 * one launch would carry two answers. A list item without the dash is a
 * value, such as `AppleLocale` in `['-screen', 'AppleLocale']`. Android reads
 * none of them.
 */
export function assertNoAppleLocaleArguments(label: string, launchArguments: ResolvedLaunchArguments | undefined, code: Code): void {
  if (launchArguments === undefined) return;
  const clash = Array.isArray(launchArguments)
    ? APPLE_LOCALE_ARGUMENTS.find((name) => launchArguments.includes(`-${name}`))
    : APPLE_LOCALE_ARGUMENTS.find((name) => Object.hasOwn(launchArguments, name));
  if (clash !== undefined) {
    fail(code, `${label} sets ${clash}, and the locale sets it too: set the language and region with the locale only`);
  }
}

/**
 * Refuses a locale on a target whose devices a provider leases when the
 * engine cannot carry it there: on Android it sets the locale with this
 * machine's `adb`, which does not reach a hosted device, and on iOS it
 * rides the launch arguments, which a provider that declares
 * `launchArguments: false` drops. The provider's own options set its
 * language.
 */
export function assertLocaleReachable(label: string, options: Pick<MobileOptions, 'platform' | 'device'>, code: Code): void {
  const provider = leasingProvider(options.device);
  if (provider === undefined) return;
  const why =
    options.platform === 'android'
      ? `leases this target's Android devices, which this machine's adb does not reach`
      : provider.launchArguments === false
        ? `drops the launch arguments that carry the locale on iOS`
        : undefined;
  if (why === undefined) return;
  const text = `${label} is set, and device provider "${provider.name}" ${why}: set the language and locale with the provider's own options instead`;
  if (code === 'INVALID_CONFIG') throw new ConfigurationError(code, text);
  throw unsupported(text);
}

/** The provider the `device` option names, or `undefined` for a local device, a list, or none. */
function leasingProvider(device: MobileOptions['device']): Pick<DeviceProvider, 'name' | 'launchArguments'> | undefined {
  if (device === undefined || typeof device === 'string' || isDeviceList(device)) return undefined;
  return device;
}

/** An Android package name: dot-separated segments that each start with a letter. */
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * Refuses an Android app named other than by its package (a display name
 * such as `Settings`): `cmd locale set-app-locales` takes a package only,
 * and `adb shell` would split a name with spaces into several words.
 */
export function assertAndroidPackage(label: string, app: string, code: Code): void {
  if (ANDROID_PACKAGE.test(app)) return;
  fail(code, `${label} on Android needs the app's package name, such as com.example.app, and ${JSON.stringify(app)} is not one: adb sets the locale of a package`);
}

/** The iOS launch arguments that start an app in `locale`: `-AppleLanguages (fr-FR) -AppleLocale fr_FR`. */
function appleLocaleArguments(locale: string): readonly string[] {
  const { language, script, region } = new Intl.Locale(locale);
  const appleLocale = `${language}${script === undefined ? '' : `-${script}`}${region === undefined ? '' : `_${region}`}`;
  return appleUserDefaults({ AppleLanguages: [locale], AppleLocale: appleLocale });
}

/**
 * The per-app locales of one Android device this machine's `adb` reaches,
 * set before a launch and put back to what the app had before when a later
 * fresh launch asks for none, and when the worker disposes, so the device is
 * left as it was found.
 */
export class AndroidAppLocales {
  /** The locales each app this worker changed had before, as `set-app-locales` takes them (`''` for none). */
  private readonly original = new Map<string, string>();
  /** The device's API level, read once per device. */
  private sdk: Promise<number> | undefined;

  constructor(
    private readonly serial: string,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly runAdb: AdbRunner,
  ) {}

  /**
   * Sets `app`'s locale, reading what it had first, or puts that back when
   * `locale` is `undefined` and the launch is fresh: a foreground-only open
   * of a running app keeps what it has, since a change would recreate its
   * screen.
   */
  async beforeOpen(app: string, locale: string | undefined, relaunch: boolean, signal: AbortSignal): Promise<void> {
    if (locale !== undefined) {
      await this.requireSdk(signal);
      if (!this.original.has(app)) this.original.set(app, await this.get(app, signal));
      await this.set(app, locale, signal);
      return;
    }
    const original = this.original.get(app);
    if (relaunch && original !== undefined) {
      await this.set(app, original, signal);
      this.original.delete(app);
    }
  }

  /**
   * Puts back `app`'s own locales once it was terminated (`device.closeApp`),
   * so the next open, which launches it fresh, runs in them.
   */
  async afterClose(app: string, signal: AbortSignal): Promise<void> {
    const original = this.original.get(app);
    if (original === undefined) return;
    await this.set(app, original, signal);
    this.original.delete(app);
  }

  /** Puts back the locales of every app this worker changed; failures are left, as the worker is going away. */
  async restore(signal: AbortSignal): Promise<void> {
    for (const [app, original] of this.original) {
      await this.set(app, original, signal).catch(() => undefined);
    }
    this.original.clear();
  }

  /** Refuses a device older than Android 13, which has no per-app language to set. */
  private async requireSdk(signal: AbortSignal): Promise<void> {
    this.sdk ??= this.adb(['shell', 'getprop', 'ro.build.version.sdk'], 'reading the Android version', signal).then((output) => Number.parseInt(output, 10));
    const sdk = await this.sdk.catch((cause: unknown) => {
      this.sdk = undefined;
      throw cause;
    });
    if (Number.isFinite(sdk) && sdk < MIN_ANDROID_SDK) {
      throw unsupported(
        `the app locale on Android needs Android 13 (API ${MIN_ANDROID_SDK}) or newer, and ${this.serial} runs API ${sdk}: use a newer emulator image, or set the device language in its settings before the run`,
      );
    }
  }

  /**
   * The app's own locales, as `cmd locale get-app-locales` prints them
   * (`Locales for <app> for user 0 are [de-DE,fr-FR]`): the tags between the
   * brackets, `''` for none. Anything else, such as `Unknown package`, is the
   * failure.
   */
  private async get(app: string, signal: AbortSignal): Promise<string> {
    const action = `reading the locale of ${app}`;
    const output = await this.adb(['shell', 'cmd', 'locale', 'get-app-locales', app], action, signal);
    const tags = /^Locales for .+ are \[(.*)\]$/.exec(output)?.[1];
    if (tags === undefined) throw new EngineError('ENGINE_FAILURE', `${action} on ${this.serial} failed: ${output}`, { retryable: false });
    return tags.replaceAll(' ', '');
  }

  /**
   * One `cmd locale set-app-locales`; `''` (no `--locales`) clears the app's
   * own locale. It prints nothing when it worked, and exits 0 even for a
   * package that is not installed, so any output is the failure.
   */
  private async set(app: string, locales: string, signal: AbortSignal): Promise<void> {
    const args = ['shell', 'cmd', 'locale', 'set-app-locales', app, ...(locales === '' ? [] : ['--locales', locales])];
    const action = locales === '' ? `clearing the locale of ${app}` : `setting the locale of ${app} to ${locales}`;
    const output = await this.adb(args, action, signal);
    if (output !== '') throw new EngineError('ENGINE_FAILURE', `${action} on ${this.serial} failed: ${output}`, { retryable: false });
  }

  /** Runs one `adb -s <serial>` command and returns its trimmed output; a failure to run or a non-zero exit is `ENGINE_FAILURE`. */
  private async adb(args: readonly string[], action: string, signal: AbortSignal): Promise<string> {
    const result = await this.runAdb(['-s', this.serial, ...args], this.env, signal);
    const output = `${result.stdout}${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      throw new EngineError('ENGINE_FAILURE', `${action} on ${this.serial} failed: ${output === '' ? `adb exited with ${result.exitCode}` : output}`, { retryable: false });
    }
    return output;
  }
}

/**
 * Runs the Android SDK's `adb`, found where agent-device looks for it:
 * `ANDROID_SDK_ROOT`, `ANDROID_HOME`, the SDK's default place for this OS,
 * then `PATH`.
 */
export const runAdb: AdbRunner = (args, env, signal) =>
  new Promise((resolve, reject) => {
    const adb = adbPath(env);
    execFile(adb, [...args], { signal, encoding: 'utf8', env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      if (error.name === 'AbortError') {
        reject(error);
        return;
      }
      if (typeof error.code === 'number') {
        resolve({ stdout, stderr, exitCode: error.code });
        return;
      }
      const hint = error.code === 'ENOENT' ? `: install the Android SDK platform-tools, and set ANDROID_HOME or put adb on PATH` : '';
      reject(new EngineError('ENGINE_FAILURE', `running ${adb} failed: ${error.message}${hint}`, { retryable: false, cause: error }));
    });
  });

function adbPath(env: Readonly<Record<string, string | undefined>>): string {
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const home = env['HOME'] ?? homedir();
  const roots = [
    env['ANDROID_SDK_ROOT'],
    env['ANDROID_HOME'],
    process.platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk') : undefined,
    path.join(home, 'Android', 'Sdk'),
  ];
  for (const root of roots) {
    if (root === undefined || root.trim() === '') continue;
    const candidate = path.join(root, 'platform-tools', executable);
    if (existsSync(candidate)) return candidate;
  }
  return executable;
}

/** The launch arguments of one launch, the locale's Apple arguments after the rest. */
export function withLocaleArguments(platform: MobilePlatform, launchArgs: readonly string[] | undefined, locale: string | undefined): readonly string[] | undefined {
  if (platform !== 'ios' || locale === undefined) return launchArgs;
  return [...(launchArgs ?? []), ...appleLocaleArguments(locale)];
}

function fail(code: Code, message: string): never {
  throw code === 'INVALID_CONFIG' ? new ConfigurationError(code, message) : new TestError(code, message);
}
