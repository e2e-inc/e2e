import { describe, expect, it } from 'vitest';
import { keyChord } from '../../src/actions.ts';
import { launchEnv } from '../../src/app-process.ts';
import { engineArguments } from '../../src/launcher.ts';

describe('launchEnv', () => {
  it('passes the run\'s environment without ELECTRON_RUN_AS_NODE and NODE_OPTIONS, the engine\'s own entries over it', () => {
    expect(launchEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', UNSET: undefined, MODE: 'run' }, { MODE: 'test', EXTRA: '1' })).toEqual({ PATH: '/bin', MODE: 'test', EXTRA: '1' });
  });

  it('lets the engine\'s env option set ELECTRON_RUN_AS_NODE on purpose', () => {
    expect(launchEnv({}, { ELECTRON_RUN_AS_NODE: '1' })).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });
});

describe('engineArguments', () => {
  it('opens the main process\'s inspector and the DevTools pipe, and no port', () => {
    expect(engineArguments([], 'darwin')).toEqual(['--inspect=0', '--remote-debugging-pipe']);
  });

  it('turns Chromium\'s sandbox off on Linux, once', () => {
    expect(engineArguments([], 'linux')).toContain('--no-sandbox');
    expect(engineArguments(['--no-sandbox'], 'linux')).not.toContain('--no-sandbox');
    expect(engineArguments([], 'win32')).not.toContain('--no-sandbox');
  });
});

describe('keyChord', () => {
  it('splits a key of the contract grammar into the key and the modifiers held with it', () => {
    expect(keyChord('Enter')).toEqual({ key: 'Enter', modifiers: [] });
    expect(keyChord('Space')).toEqual({ key: 'Space', modifiers: [] });
    expect(keyChord('Shift+Space')).toEqual({ key: 'Space', modifiers: ['Shift'] });
    expect(keyChord('ControlOrMeta+A')).toEqual({ key: 'A', modifiers: ['ControlOrMeta'] });
    expect(keyChord('Shift++')).toEqual({ key: '+', modifiers: ['Shift'] });
  });

  it('refuses a key the keyboard has none for', () => {
    expect(() => keyChord('é')).toThrow(/cannot press/);
    expect(() => keyChord('Not+A+Key+At+All')).toThrow(/not a key of the contract grammar/);
  });
});
