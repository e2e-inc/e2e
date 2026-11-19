/**
 * The object form of `app.launchArguments`, spelled for the platform's launch
 * command: `-name value` process arguments on iOS, `am start` extras of the
 * value's type on Android. A list is handed over as it is.
 */

import { ConfigurationError, TestError, checkLaunchArguments, type LaunchArgumentValue, type LaunchArguments } from '@e2e-dev/core/engine';
import type { MobilePlatform } from './options.ts';

type Code = 'INVALID_CONFIG' | 'INVALID_ARGUMENT';

/** The Apple user-defaults arguments a suite is likely to set; Android reads none of them. A name not listed here passes. */
const IOS_ONLY_ARGUMENTS: ReadonlySet<string> = new Set([
  'AppleLanguages',
  'AppleLocale',
  'AppleKeyboards',
  'AppleMeasurementUnits',
  'AppleMetricUnits',
  'AppleTemperatureUnit',
  'AppleFirstWeekday',
  'AppleTextDirection',
  'AppleICUForce24HourTime',
  'AppleICUForce12HourTime',
  'NSDoubleLocalizedStrings',
  'NSShowNonLocalizedStrings',
  'NSForceRightToLeftWritingDirection',
]);

/** What an old-style plist string may hold unquoted. `NSUserDefaults` reads a bare value that starts with `-` as the next argument's name. */
const PLIST_UNQUOTED = /^[A-Za-z0-9_$/:.][A-Za-z0-9_$/:.-]*$/;

/**
 * The launch arguments a test hands `device.openApp`, checked like the
 * target's: the declared shape, then the platform's rules.
 */
export function launchArgumentsForOpen(platform: MobilePlatform, declared: unknown): LaunchArguments | undefined {
  const label = 'device.openApp({ launchArguments })';
  const launchArguments = checkLaunchArguments(label, declared, 'INVALID_ARGUMENT');
  assertLaunchArgumentsFor(platform, label, launchArguments, 'INVALID_ARGUMENT');
  return launchArguments;
}

/**
 * Refuses an object Android cannot carry as declared: one of Apple's
 * arguments, or a list `am start` would read back changed. `--esa` splits
 * its value on every comma and keeps a backslash before one, so an item
 * holds no comma and ends in no backslash; an empty value arrives as one
 * empty item, so neither the list nor an item is empty.
 */
export function assertLaunchArgumentsFor(platform: MobilePlatform, label: string, launchArguments: LaunchArguments | undefined, code: Code = 'INVALID_CONFIG'): void {
  if (platform !== 'android' || launchArguments === undefined || Array.isArray(launchArguments)) return;
  for (const [name, value] of Object.entries(launchArguments)) {
    if (IOS_ONLY_ARGUMENTS.has(name)) {
      fail(code, `${label}.${name} is an iOS launch argument, and Android reads none of Apple's; set the device's language before the run, or language and locale on a hosted device provider`);
    }
    if (value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') continue;
    const problem = androidListProblem(value);
    if (problem !== undefined) fail(code, `${label}.${name} ${problem}: am start splits a list extra on commas`);
  }
}

function androidListProblem(items: readonly string[]): string | undefined {
  if (items.length === 0) return 'is an empty list, which Android reads as one empty item';
  const index = items.findIndex((item) => item === '' || item.includes(',') || item.endsWith('\\'));
  if (index === -1) return undefined;
  const item = items[index] ?? '';
  if (item === '') return `item ${index} is empty`;
  if (item.includes(',')) return `item ${index} holds a comma`;
  return `item ${index} ends in a backslash`;
}

/** The arguments a launch passes the platform's launch command; undefined when there are none. */
export function launchArgumentList(platform: MobilePlatform, launchArguments: LaunchArguments | undefined): readonly string[] | undefined {
  if (launchArguments === undefined) return undefined;
  const list = Array.isArray(launchArguments)
    ? launchArguments
    : Object.entries(launchArguments).flatMap(([name, value]) => {
        if (value === undefined) return [];
        return platform === 'android' ? androidExtra(name, value) : iosArgument(name, value);
      });
  return list.length === 0 ? undefined : list;
}

/**
 * `-name value` as `NSUserDefaults` reads it: `YES` or `NO` for a boolean,
 * an old-style plist array for a list, and a quoted plist string for a
 * value the parser would otherwise misread, such as `(draft)` or `-1`.
 */
function iosArgument(name: string, value: LaunchArgumentValue): string[] {
  if (typeof value === 'boolean') return [`-${name}`, value ? 'YES' : 'NO'];
  if (typeof value === 'number' || typeof value === 'string') return [`-${name}`, plistString(String(value))];
  return [`-${name}`, `(${value.map(plistString).join(', ')})`];
}

/** An old-style plist string: bare when its characters allow, else quoted with `\\` and `"` escaped. */
function plistString(item: string): string {
  return PLIST_UNQUOTED.test(item) ? item : `"${item.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Java's `int` range; `am start` parses `--ei` with `Integer.parseInt`. */
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * The extra of the value's type, so the app reads it with the matching
 * `Intent` getter: `--ez` boolean, `--ei` int, `--el` long, `--ef` float,
 * `--es` string, and `--esa` for a list, whose items `am` splits on commas.
 */
function androidExtra(name: string, value: LaunchArgumentValue): string[] {
  if (typeof value === 'boolean') return ['--ez', name, String(value)];
  if (typeof value === 'number') return [androidNumberFlag(value), name, String(value)];
  if (typeof value === 'string') return ['--es', name, value];
  return ['--esa', name, value.join(',')];
}

/** `--ei` for a whole number Java's `int` holds, `--el` for a larger one, `--ef` for a fraction. */
function androidNumberFlag(value: number): '--ei' | '--el' | '--ef' {
  if (!Number.isInteger(value)) return '--ef';
  return value >= INT32_MIN && value <= INT32_MAX ? '--ei' : '--el';
}

function fail(code: Code, message: string): never {
  throw code === 'INVALID_CONFIG' ? new ConfigurationError(code, message) : new TestError(code, message);
}
