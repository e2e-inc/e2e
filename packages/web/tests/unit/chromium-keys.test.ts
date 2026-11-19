/** Which keys Chromium takes as CDP key events, and the events: media keys, Numpad5 with NumLock off, and macOS editing shortcuts with their commands. */

import { describe, expect, it } from 'vitest';
import { chromiumKeyCommands, chromiumTypedCommands, MAC_EDITING_COMMANDS, macEditingCommands, type ChromiumKeyboard } from '../../src/driver/chromium-keys.ts';
import { characterKey, fixtureKeyStroke, KEYS, keyValue, shiftChanges, strokeSource, type KeyPhase, type Modifier } from '../../src/driver/keyboard.ts';

/** The BiDi key source of one `browser.keyboard` call, with Shift held before it or not. */
function source(key: string, phase: KeyPhase, shiftHeld: boolean) {
  return strokeSource(fixtureKeyStroke(key, phase), shiftHeld);
}

/** A keyboard with `held` modifiers down and nothing else, on macOS or not. */
function keyboard(mac: boolean, held: Modifier[] = [], pressed: string[] = []): ChromiumKeyboard {
  return { held: new Set(held), pressed: new Set(pressed), mac };
}

describe('MAC_EDITING_COMMANDS', () => {
  it('names each shortcut with its modifiers in Shift, Control, Alt, Meta order and drops the commands that insert text', () => {
    for (const [shortcut, commands] of Object.entries(MAC_EDITING_COMMANDS)) {
      const modifiers = shortcut.split('+').slice(0, -1);
      expect(modifiers).toEqual(['Shift', 'Control', 'Alt', 'Meta'].filter((modifier) => modifiers.includes(modifier)));
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) expect(command).toMatch(/^(?!insert)[a-z][A-Za-z]*$/);
    }
    expect(MAC_EDITING_COMMANDS['Enter']).toBeUndefined();
    expect(MAC_EDITING_COMMANDS['Control+KeyO']).toEqual(['moveBackward']);
  });

  it('has a key definition for every code it binds', () => {
    for (const shortcut of Object.keys(MAC_EDITING_COMMANDS)) {
      const parts = shortcut.split('+');
      const stroke = fixtureKeyStroke(parts.at(-1)!, 'keyDown');
      expect(chromiumKeyCommands(stroke, keyboard(true, parts.slice(0, -1) as Modifier[])), shortcut).toBeDefined();
    }
  });

  it('looks a shortcut up whatever order its modifiers are held in', () => {
    expect(macEditingCommands('KeyB', new Set(['Alt', 'Shift', 'Control']))).toEqual(['moveWordBackwardAndModifySelection']);
    expect(macEditingCommands('KeyB', new Set())).toEqual([]);
  });
});

describe('chromiumKeyCommands', () => {
  it('leaves to BiDi a key WebDriver presses the same way', () => {
    expect(chromiumKeyCommands(fixtureKeyStroke('KeyB', 'press'), keyboard(false))).toBeUndefined();
    expect(chromiumKeyCommands(fixtureKeyStroke('Backspace', 'press'), keyboard(false))).toBeUndefined();
    expect(chromiumKeyCommands(fixtureKeyStroke('Shift', 'keyDown'), keyboard(true))).toBeUndefined();
    expect(chromiumKeyCommands(fixtureKeyStroke('Enter', 'press'), keyboard(true))).toBeUndefined();
    expect(chromiumKeyCommands(fixtureKeyStroke('Shift+Numpad5', 'press'), keyboard(false))).toBeUndefined();
  });

  it('presses a media key, which WebDriver has no value for, with no text', () => {
    expect(chromiumKeyCommands(fixtureKeyStroke('AudioVolumeMute', 'press'), keyboard(false))).toEqual([
      { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', windowsVirtualKeyCode: 173, code: 'AudioVolumeMute', key: 'AudioVolumeMute', location: 0, isKeypad: false, modifiers: 0, autoRepeat: false, commands: [] } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', windowsVirtualKeyCode: 173, code: 'AudioVolumeMute', key: 'AudioVolumeMute', location: 0, isKeypad: false, modifiers: 0 } },
    ]);
  });

  it('presses Numpad5 as Clear on the keypad with NumLock off', () => {
    const [down] = chromiumKeyCommands(fixtureKeyStroke('Numpad5', 'press'), keyboard(false))!;
    expect(down!.params).toMatchObject({ key: 'Clear', code: 'Numpad5', windowsVirtualKeyCode: 12, location: 3, isKeypad: true });
  });

  it('names the editing commands of a macOS shortcut and presses its modifiers around the key', () => {
    const commands = chromiumKeyCommands(fixtureKeyStroke('Shift+Control+Alt+KeyB', 'press'), keyboard(true))!;
    expect(commands.map(({ params }) => [params['type'], params['key'], params['modifiers']])).toEqual([
      ['rawKeyDown', 'Shift', 8],
      ['rawKeyDown', 'Control', 10],
      ['rawKeyDown', 'Alt', 11],
      ['rawKeyDown', 'B', 11],
      ['keyUp', 'B', 11],
      ['keyUp', 'Alt', 10],
      ['keyUp', 'Control', 8],
      ['keyUp', 'Shift', 0],
    ]);
    expect(commands[3]!.params['commands']).toEqual(['moveWordBackwardAndModifySelection']);
  });

  it('counts modifiers BiDi holds, without pressing them again', () => {
    const commands = chromiumKeyCommands(fixtureKeyStroke('Shift+ArrowUp', 'press'), keyboard(true, ['Shift', 'Meta']))!;
    expect(commands.map(({ params }) => params['key'])).toEqual(['ArrowUp', 'ArrowUp']);
    expect(commands[0]!.params).toMatchObject({ modifiers: 12, commands: ['moveToBeginningOfDocumentAndModifySelection'] });
  });

  it('types a letter of a shortcut only while no modifier but Shift is held', () => {
    const [down] = chromiumKeyCommands(fixtureKeyStroke('Meta+KeyA', 'press'), keyboard(true))!.slice(1);
    expect(down!.params).toMatchObject({ type: 'rawKeyDown', key: 'a', commands: ['selectAll'] });
    expect(down!.params['text']).toBeUndefined();
  });

  it('runs no macOS editing command off macOS', () => {
    expect(chromiumKeyCommands(fixtureKeyStroke('Shift+Meta+ArrowUp', 'press'), keyboard(false))).toBeUndefined();
  });

  it('cancels a drag on Escape, as the mapper does', () => {
    expect(chromiumKeyCommands(fixtureKeyStroke('Escape', 'press'), keyboard(true))!.map(({ method }) => method)).toEqual(['Input.cancelDragging', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
    expect(chromiumKeyCommands(fixtureKeyStroke('Alt+Escape', 'press'), keyboard(true))!.map(({ method }) => method)).not.toContain('Input.cancelDragging');
  });

  it('holds a key through CDP, repeats it, and releases it there', () => {
    const down = chromiumKeyCommands(fixtureKeyStroke('ArrowLeft', 'keyDown'), keyboard(true))!;
    expect(down.map(({ params }) => params['type'])).toEqual(['rawKeyDown']);
    expect(chromiumKeyCommands(fixtureKeyStroke('ArrowLeft', 'keyDown'), keyboard(true, [], ['ArrowLeft']))![0]!.params['autoRepeat']).toBe(true);
    expect(chromiumKeyCommands(fixtureKeyStroke('ArrowLeft', 'keyUp'), keyboard(true, [], ['ArrowLeft']))!.map(({ params }) => params['type'])).toEqual(['keyUp']);
    expect(chromiumKeyCommands(fixtureKeyStroke('ArrowLeft', 'keyUp'), keyboard(true))).toBeUndefined();
  });
});

describe('numpad keys on BiDi', () => {
  it('presses the NumLock-off key without Shift and the digit with it', () => {
    expect(source('NumpadDecimal', 'press', false).actions[0]).toEqual({ type: 'keyDown', value: '' });
    expect(source('NumpadDecimal', 'press', true).actions[0]).toEqual({ type: 'keyDown', value: '' });
    expect(source('Shift+Numpad1', 'press', false).actions[1]).toEqual({ type: 'keyDown', value: '' });
    expect(source('Numpad1', 'press', false).actions[0]).toEqual({ type: 'keyDown', value: '' });
  });

  it('refuses a key WebDriver has no value for', () => {
    expect(keyValue(KEYS.get('MediaPlayPause')!, false)).toBeUndefined();
    expect(keyValue(KEYS.get('Numpad5')!, true)).toBe('\uE01F');
    expect(() => source('MediaPlayPause', 'press', false)).toThrow('WebDriver defines no key value for "MediaPlayPause"');
    expect(() => source('Numpad5', 'press', false)).toThrow('"Numpad5" with NumLock off (key "Clear")');
  });
});

describe('chromiumTypedCommands', () => {
  it('types a character as written under a held Shift: its key down and up, entering the character itself', () => {
    expect(chromiumTypedCommands('a', new Set<Modifier>(['Shift'])).map((command) => command.params)).toEqual([
      { type: 'keyDown', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', location: 0, isKeypad: false, modifiers: 8, text: 'a', unmodifiedText: 'a' },
      { type: 'keyUp', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', location: 0, isKeypad: false, modifiers: 8 },
    ]);
    expect(chromiumTypedCommands('1', new Set<Modifier>(['Shift']))[0]!.params).toMatchObject({ code: 'Digit1', key: '1', text: '1' });
    expect(chromiumTypedCommands('é', new Set<Modifier>(['Shift']))).toEqual([]);
  });
});

describe('the key of a character', () => {
  it('is the key of the main keyboard that types it, with Shift or without', () => {
    expect(characterKey('a')).toMatchObject({ definition: { code: 'KeyA' }, shifted: false });
    expect(characterKey('~')).toMatchObject({ definition: { code: 'Backquote' }, shifted: true });
    expect(characterKey('1')).toMatchObject({ definition: { code: 'Digit1' }, shifted: false });
    expect(characterKey('é')).toBeUndefined();
    for (let code = 0x20; code <= 0x7e; code += 1) expect(characterKey(String.fromCharCode(code)), String.fromCharCode(code)).toBeDefined();
  });

  it('is changed by a held Shift only when it has another character to type', () => {
    expect([...'az09`-=[];,./'].every(shiftChanges)).toBe(true);
    expect([...'AZ~!@_+{}:<>? '].some(shiftChanges)).toBe(false);
  });
});
