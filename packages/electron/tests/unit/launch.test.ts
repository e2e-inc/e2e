import { describe, expect, it } from 'vitest';
import { playwrightKey } from '../../src/actions.ts';
import { launchEnv, launchFailure } from '../../src/app-process.ts';

describe('launchFailure', () => {
  it('adds what the app wrote to stderr, each line once, to the first line of the failure', () => {
    const cause = new Error(['electron.launch: Process failed to launch!', '  - <launching> /app/electron .', '  - [err] Error: Cannot find module \'./main\'', '  - [err] Error: Cannot find module \'./main\'', '  - [err] ', '  - [out] ready'].join('\n'));
    expect(launchFailure(cause)).toBe('electron.launch: Process failed to launch! The app wrote to stderr:\nError: Cannot find module \'./main\'');
  });

  it('keeps a failure with no stderr to its first line', () => {
    expect(launchFailure(new Error('electron.launch: Timeout 30000ms exceeded.\nCall log:\n  - <launching>'))).toBe('electron.launch: Timeout 30000ms exceeded.');
    expect(launchFailure('nope')).toBe('nope');
  });
});

describe('launchEnv', () => {
  it('passes the run\'s environment without ELECTRON_RUN_AS_NODE, the engine\'s own entries over it', () => {
    expect(launchEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', UNSET: undefined, MODE: 'run' }, { MODE: 'test', EXTRA: '1' })).toEqual({ PATH: '/bin', MODE: 'test', EXTRA: '1' });
  });

  it('lets the engine\'s env option set ELECTRON_RUN_AS_NODE on purpose', () => {
    expect(launchEnv({}, { ELECTRON_RUN_AS_NODE: '1' })).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });
});

describe('playwrightKey', () => {
  it('spells Space as Playwright does, alone and in a chord', () => {
    expect(playwrightKey('Space')).toBe(' ');
    expect(playwrightKey('Shift+Space')).toBe('Shift+ ');
    expect(playwrightKey('ControlOrMeta+A')).toBe('ControlOrMeta+A');
    expect(playwrightKey('Enter')).toBe('Enter');
  });

  it('refuses a key the keyboard has none for', () => {
    expect(() => playwrightKey('é')).toThrow(/cannot press/);
    expect(() => playwrightKey('Not+A+Key+At+All')).toThrow(/not a key of the contract grammar/);
  });
});
