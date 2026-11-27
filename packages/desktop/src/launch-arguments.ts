import { appleUserDefaults, type EngineAppInfo, type LaunchArgumentValues } from '@e2e-dev/core/engine';

/** What every launch sets: no window or document the app saved at its last quit comes back. */
const FRESH_STATE = { ApplePersistenceIgnoreState: true } satisfies LaunchArgumentValues;

/**
 * What a launch sets for an app that can keep documents in iCloud: a new document is saved on this Mac, not in
 * iCloud Drive, where each run would leave one behind and sync it. No other app gets it, since an app that does not
 * read user defaults takes the value for something to open: Chromium opens `NO` as a URL.
 */
const LOCAL_DOCUMENTS = { NSDocumentSaveNewDocumentsToCloud: false } satisfies LaunchArgumentValues;

/**
 * The arguments of a launch: the engine's user defaults, then the target's. A default the target sets itself is sent
 * once, with the target's value. A list is sent after the engine's defaults, where a repeated one wins: the last is
 * the one read.
 */
export function launchArgumentLists(app: Pick<EngineAppInfo, 'launchArguments' | 'launchArgumentValues'>): {
  readonly arguments: readonly string[];
  readonly cloudDocumentArguments: readonly string[];
} {
  const values = app.launchArgumentValues;
  if (values === undefined) {
    return { arguments: [...appleUserDefaults(FRESH_STATE), ...(app.launchArguments ?? [])], cloudDocumentArguments: appleUserDefaults(LOCAL_DOCUMENTS) };
  }
  const unset = Object.entries(LOCAL_DOCUMENTS).filter(([name]) => !Object.hasOwn(values, name));
  return { arguments: appleUserDefaults({ ...FRESH_STATE, ...values }), cloudDocumentArguments: appleUserDefaults(Object.fromEntries(unset)) };
}
