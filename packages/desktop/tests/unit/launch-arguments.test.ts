import { describe, expect, it } from 'vitest';
import { launchArgumentLists } from '../../src/launch-arguments.ts';

const FRESH_STATE = ['-ApplePersistenceIgnoreState', 'YES'];
const LOCAL_DOCUMENTS = ['-NSDocumentSaveNewDocumentsToCloud', 'NO'];

describe('launchArgumentLists', () => {
  it("sends a list as given after the engine's defaults, and only those for none", () => {
    expect(launchArgumentLists({ launchArguments: ['-e2e', 'YES'] })).toEqual({ arguments: [...FRESH_STATE, '-e2e', 'YES'], cloudDocumentArguments: LOCAL_DOCUMENTS });
    expect(launchArgumentLists({})).toEqual({ arguments: FRESH_STATE, cloudDocumentArguments: LOCAL_DOCUMENTS });
    expect(launchArgumentLists({ launchArgumentValues: {} })).toEqual({ arguments: FRESH_STATE, cloudDocumentArguments: LOCAL_DOCUMENTS });
  });

  it("sends a default the target sets itself once, with the target's value", () => {
    expect(launchArgumentLists({ launchArgumentValues: { NSDocumentSaveNewDocumentsToCloud: true } })).toEqual({
      arguments: [...FRESH_STATE, '-NSDocumentSaveNewDocumentsToCloud', 'YES'],
      cloudDocumentArguments: [],
    });
    expect(launchArgumentLists({ launchArgumentValues: { ApplePersistenceIgnoreState: false } })).toEqual({
      arguments: ['-ApplePersistenceIgnoreState', 'NO'],
      cloudDocumentArguments: LOCAL_DOCUMENTS,
    });
  });

  it('spells an object as user defaults the way NSUserDefaults reads them', () => {
    expect(launchArgumentLists({ launchArgumentValues: { AppleLanguages: ['fr', 'en-GB'], AppleLocale: 'fr_FR', e2e: true, dark: false, retries: 3, offset: -1, mode: '(draft)', flag: '-x', quote: 'say "hi"\\' } }).arguments).toEqual([
      ...FRESH_STATE,
      '-AppleLanguages', '(fr, en-GB)',
      '-AppleLocale', 'fr_FR',
      '-e2e', 'YES',
      '-dark', 'NO',
      '-retries', '3',
      '-offset', '"-1"',
      '-mode', '"(draft)"',
      '-flag', '"-x"',
      '-quote', '"say \\"hi\\"\\\\"',
    ]);
  });
});
