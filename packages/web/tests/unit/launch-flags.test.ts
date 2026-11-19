/**
 * What a launch writes into a fresh Firefox profile: the driver's own
 * preferences, and the one media feature Firefox takes only at launch.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { firefoxArgs } from '../../src/driver/launch-flags.ts';
import type { WebMedia } from '../../src/options.ts';

const profiles: string[] = [];

afterEach(() => {
  for (const profile of profiles.splice(0)) rmSync(profile, { recursive: true, force: true });
});

/** The preference lines `firefoxArgs` writes into a fresh profile for `media`. */
function preferences(media: WebMedia): string[] {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'e2e-launch-flags-'));
  profiles.push(profile);
  expect(firefoxArgs(profile, false, media)).toEqual(expect.arrayContaining(['--profile', profile, '--headless']));
  return readFileSync(path.join(profile, 'user.js'), 'utf8').trim().split('\n');
}

describe('firefoxArgs', () => {
  it('writes the reduced motion the launch asks for as a preference, beside the driver’s own', () => {
    expect(preferences({ reducedMotion: 'reduce' })).toEqual(expect.arrayContaining(['user_pref("ui.prefersReducedMotion", 1);', 'user_pref("remote.retry-on-abort", false);']));
    expect(preferences({ reducedMotion: 'no-preference' })).toContain('user_pref("ui.prefersReducedMotion", 0);');
  });

  it('leaves reduced motion to the browser when the launch asks for none, and the color scheme to the media override', () => {
    const own = preferences({});
    expect(own).toContain('user_pref("remote.retry-on-abort", false);');
    expect(own.filter((line) => line.includes('prefersReducedMotion'))).toEqual([]);
    expect(preferences({ colorScheme: 'dark' })).toEqual(own);
  });
});
