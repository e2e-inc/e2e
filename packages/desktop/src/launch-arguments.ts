import type { LaunchArgumentValue, ResolvedLaunchArguments } from '@e2e-dev/core/engine';

/** What an old-style plist string may hold unquoted. `NSUserDefaults` reads a bare value that starts with `-` as the next argument's name. */
const PLIST_UNQUOTED = /^[A-Za-z0-9_$/:.][A-Za-z0-9_$/:.-]*$/;

/**
 * The process arguments `app.launchArguments` passes the app: a list as it
 * is, an object as `-name value` user defaults.
 */
export function launchArgumentList(launchArguments: ResolvedLaunchArguments | undefined): readonly string[] {
  if (launchArguments === undefined) return [];
  if (Array.isArray(launchArguments)) return launchArguments;
  return Object.entries(launchArguments).flatMap(([name, value]) => userDefault(name, value));
}

/**
 * `-name value` as `NSUserDefaults` reads it: `YES` or `NO` for a boolean,
 * an old-style plist array for a list, and a quoted plist string for a
 * value the parser would otherwise misread, such as `(draft)` or `-1`.
 */
function userDefault(name: string, value: LaunchArgumentValue): string[] {
  if (typeof value === 'boolean') return [`-${name}`, value ? 'YES' : 'NO'];
  if (typeof value === 'number' || typeof value === 'string') return [`-${name}`, plistString(String(value))];
  return [`-${name}`, `(${value.map(plistString).join(', ')})`];
}

/** An old-style plist string: bare when its characters allow, else quoted with `\\` and `"` escaped. */
function plistString(item: string): string {
  return PLIST_UNQUOTED.test(item) ? item : `"${item.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
