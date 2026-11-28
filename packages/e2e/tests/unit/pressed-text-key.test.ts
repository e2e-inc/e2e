import { describe, expect, it } from 'vitest';
import { pressedTextCharacter } from '@e2e-dev/core/lib/internal/keys';

describe('a keypress that inserts one character', () => {
  it.each([
    ['1', '1'],
    ['a', 'a'],
    ['Shift+a', 'a'],
    ['Shift+1', '1'],
    ['Shift++', '+'],
    ['Enter', undefined],
    ['Shift+Tab', undefined],
    ['Control+a', undefined],
    ['ControlOrMeta+a', undefined],
    ['Meta+a', undefined],
    ['Alt+a', undefined],
    ['abc', undefined],
  ] as const)('%s becomes %s', (key, character) => {
    expect(pressedTextCharacter(key)).toBe(character);
  });
});
