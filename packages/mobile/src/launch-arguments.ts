/**
 * The object form of `app.launchArguments`, spelled for the platform's launch
 * command: `-name value` process arguments on iOS, `am start` string extras
 * on Android. A list is handed over as it is.
 */

import { ConfigurationError, type LaunchArgumentValue, type LaunchArguments } from '@e2e-dev/core/engine';
import type { MobilePlatform } from './options.ts';

/** Apple's user-defaults arguments. Android reads none of them. */
const IOS_ONLY_ARGUMENTS: ReadonlySet<string> = new Set([
  'AppleLanguages',
  'AppleLocale',
  'AppleTextDirection',
  'AppleICUForce24HourTime',
  'AppleICUForce12HourTime',
  'NSDoubleLocalizedStrings',
  'NSShowNonLocalizedStrings',
  'NSForceRightToLeftWritingDirection',
]);

/** What an old-style plist string may hold unquoted. */
const PLIST_UNQUOTED = /^[A-Za-z0-9_$/:.-]+$/;

/** Refuses an Apple argument in an object on an Android target. */
export function assertLaunchArgumentsFor(platform: MobilePlatform, label: string, launchArguments: LaunchArguments | undefined): void {
  if (platform !== 'android' || launchArguments === undefined || Array.isArray(launchArguments)) return;
  const name = Object.keys(launchArguments).find((key) => IOS_ONLY_ARGUMENTS.has(key));
  if (name === undefined) return;
  throw new ConfigurationError(
    'INVALID_CONFIG',
    `${label}.${name} is an iOS launch argument, and Android reads none of Apple's; set the device's language before the run, or language and locale on a hosted device provider`,
  );
}

/** The arguments a launch passes the platform's launch command; undefined when there are none. */
export function launchArgumentList(platform: MobilePlatform, launchArguments: LaunchArguments | undefined): readonly string[] | undefined {
  if (launchArguments === undefined) return undefined;
  const list = Array.isArray(launchArguments)
    ? launchArguments
    : Object.entries(launchArguments).flatMap(([name, value]) => (platform === 'android' ? androidExtra(name, value) : iosArgument(name, value)));
  return list.length === 0 ? undefined : list;
}

/** `-name value` as `NSUserDefaults` reads it: `YES` or `NO` for a boolean, an old-style plist array for a list. */
function iosArgument(name: string, value: LaunchArgumentValue): string[] {
  if (typeof value === 'boolean') return [`-${name}`, value ? 'YES' : 'NO'];
  if (typeof value === 'string' || typeof value === 'number') return [`-${name}`, String(value)];
  return [`-${name}`, `(${value.map(plistString).join(', ')})`];
}

function plistString(item: string): string {
  return PLIST_UNQUOTED.test(item) ? item : `"${item.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** `--es name value`, or `--esa` for a list, whose items `am` splits on an unescaped comma. */
function androidExtra(name: string, value: LaunchArgumentValue): string[] {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return ['--es', name, String(value)];
  return ['--esa', name, value.map((item) => item.replaceAll(',', '\\,')).join(',')];
}
