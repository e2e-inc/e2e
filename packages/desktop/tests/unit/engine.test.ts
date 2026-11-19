import { describe, expect, it } from 'vitest';
import { desktop } from '../../src/engine.ts';
import { resolveOptions } from '../../src/options.ts';

describe('desktop()', () => {
  it('offers the pointer-only actions with headed alone', () => {
    const plain = desktop();
    const headed = desktop({ headed: true });
    expect(plain.actions).not.toContain('doubleTap');
    expect(plain.actions).not.toContain('hover');
    expect(plain.pointerActions).toBeUndefined();
    expect(headed.actions).toEqual(expect.arrayContaining(['doubleTap', 'hover']));
    expect(headed.pointerActions).toEqual(expect.arrayContaining(['tap']));
    expect(plain.workers).toBe(1);
  });

  it('refuses options it does not take', () => {
    expect(() => resolveOptions({ settle: 1.5 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions({ binary: '' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions({ snapshot: 'all' as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions({ bogus: 1 } as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(resolveOptions({ settle: false })).toMatchObject({ settleMs: 0, headed: false, interactiveOnly: false });
  });

  it('refuses an app it cannot launch', () => {
    const engine = desktop();
    const check = (app: Record<string, unknown>) => () => engine.validateApp?.(app, { targetName: 'mac' });
    expect(check({ url: 'http://localhost:3000' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({})).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({ bundleId: 'com.example.app', permissions: { camera: 'grant' } })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({ bundleId: 'com.example.app' })).not.toThrow();
    if (process.platform === 'darwin') {
      expect(check({ appPath: 'build/App.zip' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
      expect(check({ appPath: 'build/App.app' })).not.toThrow();
    } else {
      expect(check({ appPath: 'build/App.app' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });
});
