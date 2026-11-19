/**
 * The project this directory runs in is the Chromium one, whatever
 * `E2E_WEB_BROWSER` the shell exports: `vitest.config.ts` sets it for each
 * integration project, so an exported `firefox` cannot run both on Firefox.
 */

import { expect, it } from 'vitest';
import { testBrowser } from '../../helpers/web-session.ts';

it('runs the Chromium project on Chromium', () => {
  expect(testBrowser()).toBe('chromium');
});
