import { describe, expect, it } from 'vitest';
import { assertLaunchArgumentsFor, launchArgumentList } from '../../src/launch-arguments.ts';

describe('launchArgumentList', () => {
  it('passes a list through as given and sends nothing for none', () => {
    expect(launchArgumentList('ios', ['-e2e', 'YES'])).toEqual(['-e2e', 'YES']);
    expect(launchArgumentList('android', ['--ez', 'e2e', 'true'])).toEqual(['--ez', 'e2e', 'true']);
    expect(launchArgumentList('ios', undefined)).toBeUndefined();
    expect(launchArgumentList('ios', [])).toBeUndefined();
    expect(launchArgumentList('android', {})).toBeUndefined();
  });

  it('spells an object as iOS process arguments', () => {
    expect(launchArgumentList('ios', { AppleLocale: 'fr_FR', e2e: true, dark: false, retries: 3, ratio: 1.5 })).toEqual([
      '-AppleLocale', 'fr_FR',
      '-e2e', 'YES',
      '-dark', 'NO',
      '-retries', '3',
      '-ratio', '1.5',
    ]);
    expect(launchArgumentList('ios', { AppleLanguages: ['fr'] })).toEqual(['-AppleLanguages', '(fr)']);
    expect(launchArgumentList('ios', { AppleLanguages: ['fr', 'en-GB', 'zh-Hans'] })).toEqual(['-AppleLanguages', '(fr, en-GB, zh-Hans)']);
  });

  it('quotes a list item an old-style plist cannot carry bare', () => {
    expect(launchArgumentList('ios', { names: ['a b', 'say "hi"', 'back\\slash', 'x,y', 'ok_1.2:3/4-5$'] })).toEqual([
      '-names',
      '("a b", "say \\"hi\\"", "back\\\\slash", "x,y", ok_1.2:3/4-5$)',
    ]);
    expect(launchArgumentList('ios', { empty: [] })).toEqual(['-empty', '()']);
  });

  it("spells an object as am start extras of each value's type", () => {
    expect(launchArgumentList('android', { e2e: true, dark: false, locale: 'fr_FR', retries: 3, ratio: 1.5, epoch: 2 ** 31, negative: -1 })).toEqual([
      '--ez', 'e2e', 'true',
      '--ez', 'dark', 'false',
      '--es', 'locale', 'fr_FR',
      '--ei', 'retries', '3',
      '--ef', 'ratio', '1.5',
      '--el', 'epoch', '2147483648',
      '--ei', 'negative', '-1',
    ]);
    expect(launchArgumentList('android', { tags: ['a', 'b,c', 'd'] })).toEqual(['--esa', 'tags', 'a,b\\,c,d']);
    expect(launchArgumentList('android', { tags: [] })).toEqual(['--esa', 'tags', '']);
  });
});

describe('assertLaunchArgumentsFor', () => {
  it("refuses Apple's arguments in an object on Android, and nothing else", () => {
    for (const name of ['AppleLanguages', 'AppleLocale', 'AppleTextDirection', 'NSDoubleLocalizedStrings']) {
      expect(() => assertLaunchArgumentsFor('android', 'target "pixel" app.launchArguments', { [name]: 'x' })).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining(`target "pixel" app.launchArguments.${name} is an iOS launch argument`) }),
      );
    }
    expect(() => assertLaunchArgumentsFor('android', 'label', { e2e: true, ApplePayEnabled: true })).not.toThrow();
    expect(() => assertLaunchArgumentsFor('android', 'label', ['-AppleLocale', 'fr_FR'])).not.toThrow();
    expect(() => assertLaunchArgumentsFor('android', 'label', undefined)).not.toThrow();
    expect(() => assertLaunchArgumentsFor('ios', 'label', { AppleLocale: 'fr_FR' })).not.toThrow();
  });
});
