import { appleUserDefaults, type ResolvedLaunchArguments } from '@e2e-dev/core/engine';

/**
 * The process arguments `app.launchArguments` passes the app: a list as it
 * is, an object as `-name value` user defaults.
 */
export function launchArgumentList(launchArguments: ResolvedLaunchArguments | undefined): readonly string[] {
  return launchArguments === undefined ? [] : appleUserDefaults(launchArguments);
}
