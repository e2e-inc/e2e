import { describe, expect, it } from 'vitest';
import { toCombo } from '../../src/keys.ts';

describe('toCombo', () => {
  it('names the contract keys the way agent-desktop takes them', () => {
    expect(toCombo('Enter', 'macos')).toBe('return');
    expect(toCombo('Escape', 'linux')).toBe('escape');
    expect(toCombo('Backspace', 'windows')).toBe('backspace');
    expect(toCombo('Delete', 'macos')).toBe('forwarddelete');
    expect(toCombo('ArrowDown', 'macos')).toBe('down');
    expect(toCombo('PageUp', 'macos')).toBe('pageup');
    expect(toCombo('F5', 'windows')).toBe('f5');
    expect(toCombo('Space', 'macos')).toBe('space');
    expect(toCombo(' ', 'macos')).toBe('space');
  });

  it('maps modifiers, with ControlOrMeta per OS', () => {
    expect(toCombo('Shift+Tab', 'macos')).toBe('shift+tab');
    expect(toCombo('ControlOrMeta+a', 'macos')).toBe('cmd+a');
    expect(toCombo('ControlOrMeta+a', 'windows')).toBe('ctrl+a');
    expect(toCombo('Meta+Alt+Escape', 'macos')).toBe('cmd+alt+escape');
    expect(toCombo('Control+c', 'linux')).toBe('ctrl+c');
  });

  it('keeps a capital letter capital once agent-desktop lower-cases the combo', () => {
    expect(toCombo('A', 'macos')).toBe('A');
    expect(toCombo('Control+A', 'linux')).toBe('ctrl+shift+A');
  });

  it('refuses what agent-desktop cannot press', () => {
    expect(() => toCombo('Insert', 'windows')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
    expect(() => toCombo('+', 'macos')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
    expect(() => toCombo('Hyper+a', 'macos')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  });
});
