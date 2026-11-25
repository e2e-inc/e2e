/**
 * `web({ dialogs })` in a real browser: what the page gets back from a dialog
 * no `browser.onDialog` handler takes, and that a test's own handler still
 * answers first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProjectWithConfigFile, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const DIALOGS = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('answers dialogs no handler takes', async ({ app, browser }) => {
  await app.open('/dialog');
  expect(await browser.evaluate("() => confirm('Delete?')")).toBe(process.env.EXPECT_CONFIRM === 'true');
  expect(await browser.evaluate("() => prompt('Name?', 'keep me')")).toBe(process.env.EXPECT_CONFIRM === 'true' ? 'keep me' : null);
  expect(await browser.title()).toBe('Dialog page');
});

test('a handler the test registers comes first', async ({ app, browser }) => {
  await app.open('/dialog');
  await browser.onDialog(async (dialog) => dialog.accept('from the test'));
  expect(await browser.evaluate("() => prompt('Name?', 'keep me')")).toBe('from the test');
  expect(await browser.title()).toBe('Dialog page');
});
`;

/** A config whose one web target answers with `policy`. */
function configSource(policy: 'accept' | 'dismiss'): string {
  return `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

process.env.EXPECT_CONFIRM = '${String(policy === 'accept')}';

export default {
  targets: [{ name: 'web', engine: web({ dialogs: '${policy}' }), app: { url: process.env.APP_URL! } }],
  workers: 1,
  cache: 'off',
  actionTimeout: 5_000,
  timeout: 30_000,
} satisfies E2EConfig;
`;
}

describe('web({ dialogs })', () => {
  let app: FixtureApp;
  const projects: FixtureProject[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    for (const project of projects) project.cleanup();
    await app?.close();
  });

  it.each(['accept', 'dismiss'] as const)('answers with %s, keeping a prompt\'s default text, and lets a test handler answer first', async (policy) => {
    const { outcome, project }: { outcome: RunOutcome; project: FixtureProject } = await runProjectWithConfigFile(
      { 'tests/dialogs.e2e.ts': DIALOGS },
      { appUrl: app.url, configSource: configSource(policy) },
    );
    projects.push(project);
    for (const title of ['answers dialogs no handler takes', 'a handler the test registers comes first']) {
      const result = resultByTitle(outcome, title);
      expect(result.status, `${title}: ${result.attempts[0]?.error?.message ?? ''}`).toBe('passed');
    }
  }, 120_000);
});
