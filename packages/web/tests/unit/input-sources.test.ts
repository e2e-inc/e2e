/** The `input.performActions` sources the contract's key grammar and gestures become. */

import { describe, expect, it } from 'vitest';
import { clickSources, typeSource } from '../../src/driver/input-sources.ts';
import { pressStroke, strokeSource } from '../../src/driver/keyboard.ts';

describe('input sources', () => {
  it('presses a named key with its modifiers held around it', () => {
    expect(strokeSource(pressStroke('Shift+Tab'), false).actions).toEqual([
      { type: 'keyDown', value: '' },
      { type: 'keyDown', value: '' },
      { type: 'keyUp', value: '' },
      { type: 'keyUp', value: '' },
    ]);
  });

  it('presses one key per grapheme it is given, a newline or a carriage return as Enter', () => {
    expect(typeSource(['a', '👍🏽', '\n', '\r\n', '\r']).actions.map((action) => (action.type === 'pause' ? '' : action.value))).toEqual([
      'a', 'a', '👍🏽', '👍🏽', '', '', '', '', '', '',
    ]);
  });

  it('holds modifiers on a key source across every tick of the click', () => {
    const [keys, pointer] = clickSources(10, 20, { modifiers: ['Alt'] });
    expect(keys?.type).toBe('key');
    expect(keys?.actions[0]).toEqual({ type: 'keyDown', value: '\uE00A' });
    expect(keys?.actions.at(-1)).toEqual({ type: 'keyUp', value: '\uE00A' });
    // The release lands on the tick after the pointer's last.
    expect(keys?.actions).toHaveLength(pointer!.actions.length + 1);
    expect(pointer?.actions.filter((action) => action.type === 'pointerDown')).toHaveLength(1);
  });
});
