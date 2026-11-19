/**
 * What `web()` accepts and what the engine it builds offers. What the
 * browser does with them is covered by the integration tests.
 */

import { describe, expect, it } from 'vitest';
import { web, type WebOptions } from '../../src/index.ts';

describe('web()', () => {
  it('refuses the removed driver option and webkit, naming why', () => {
    expect(() => web({ driver: 'bidi' } as unknown as WebOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('unknown key "driver"') }));
    expect(() => web({ browser: 'webkit' } as unknown as WebOptions)).toThrow(/drives chromium or firefox over WebDriver BiDi, got "webkit"/);
  });

  it('validates the options it takes', () => {
    expect(() => web({ locale: 'de-DE', timezoneId: 'Europe/Berlin', headers: { 'x-a': 'b' }, colorScheme: 'dark' })).not.toThrow();
    expect(() => web({ headers: { 'x bad': 'b' } })).toThrow(/invalid header name/);
  });

  it('offers the browser fixture, saved sessions, and video', () => {
    const engine = web({ browser: 'firefox' });
    expect(Object.keys(engine.fixtures ?? {})).toEqual(['browser']);
    expect(engine.state).toBeDefined();
    expect(engine.artifacts?.startVideo).toBeDefined();
  });
});
