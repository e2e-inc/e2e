/**
 * A target whose app is a file on disk, in a real browser through the
 * runner: the file opens with no server, navigation reaches the files beside
 * it, and a file outside its directory or a directory is refused.
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { contentsUnder, createProject, resultByTitle, runExisting, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('opens the file and a page beside it', async ({ app, browser, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading', 'Home')).toBeVisible();
  await app.open('pages/about.html');
  await expect(screen.getByRole('heading', 'About')).toBeVisible();
  await screen.getByRole('link', 'Home').tap();
  await expect(screen.getByRole('heading', 'Home')).toBeVisible();
  expect(await browser.url()).toMatch(/^file:.*\\/site\\/index\\.html$/);
});

for (const target of ['../secret.html', '/etc/hosts', 'file:///etc/hosts', '..%2fsecret.html', 'pages']) {
  test('app.open refuses ' + JSON.stringify(target), async ({ app }) => {
    await app.open();
    await app.open(target);
  });
}

test('browser.goto refuses a file outside the directory', async ({ app, browser }) => {
  await app.open();
  await browser.goto('../secret.html');
});

test('a failure after the page left the directory', async ({ app, browser, screen }) => {
  await app.open();
  await screen.getByRole('link', 'Notes').tap();
  await browser.waitForURL(/secret\\.html$/);
  throw new Error('failed on the page outside');
});
`;

const AGENT_SUITE = `import { test } from '@e2e-dev/web';

test('the agent cannot be led out of the directory', async ({ app, agent }) => {
  await app.open();
  await agent.act('Read the notes');
});
`;

const SITE = {
  'site/index.html': '<!doctype html><title>Home</title><h1>Home</h1><a href="pages/about.html">About</a><a href="../secret.html">Notes</a>',
  'site/pages/about.html': '<!doctype html><title>About</title><h1>About</h1><a href="../index.html">Home</a>',
  'secret.html': '<!doctype html><h1>TOP-SECRET-NOTES</h1>',
};

const fileUrl = (project: FixtureProject): string => pathToFileURL(path.join(project.dir, 'site', 'index.html')).href;

describe('a file app', () => {
  let project: FixtureProject;
  let outcome: RunOutcome;

  beforeAll(async () => {
    project = createProject({ 'tests/file.e2e.ts': SUITE, ...SITE });
    outcome = await runExisting(project, { appUrl: fileUrl(project) });
  });

  afterAll(() => project?.cleanup());

  it('opens the file with no server, and the pages in its directory', () => {
    const result = resultByTitle(outcome, 'opens the file and a page beside it');
    expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
  });

  it('refuses a file outside the directory, however it is spelled, and a directory', () => {
    for (const target of ['../secret.html', '/etc/hosts', 'file:///etc/hosts', '..%2fsecret.html']) {
      const error = resultByTitle(outcome, `app.open refuses ${JSON.stringify(target)}`).attempts[0]!.error;
      expect(error, target).toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining("stays in the directory of the app's file") });
    }
    expect(resultByTitle(outcome, 'app.open refuses "pages"').attempts[0]!.error).toMatchObject({
      code: 'POLICY_DENIED',
      message: expect.stringContaining('opens a file, not a directory'),
    });
    expect(resultByTitle(outcome, 'browser.goto refuses a file outside the directory').attempts[0]!.error).toMatchObject({ code: 'POLICY_DENIED' });
  });
});

describe('a file app whose page left the directory', () => {
  let project: FixtureProject;
  let outcome: RunOutcome;

  beforeAll(async () => {
    project = createProject({ 'tests/file.e2e.ts': SUITE, ...SITE });
    outcome = await runExisting(project, { appUrl: fileUrl(project), runOptions: { grep: [/a failure after the page left/] } });
  });

  afterAll(() => project?.cleanup());

  it('keeps where the failure was, and nothing of the screen: no tree, no screenshot, no trace screen', () => {
    const attempt = resultByTitle(outcome, 'a failure after the page left the directory').attempts[0]!;
    expect(attempt.error?.message).toContain('failed on the page outside');
    expect(attempt.failure).toEqual({ url: expect.stringMatching(/secret\.html$/) });
    expect(attempt.artifacts.filter((artifact) => artifact.kind === 'screenshot')).toEqual([]);
    const kept = contentsUnder(path.join(project.dir, '.e2e')).filter(([, content]) => content.includes('TOP-SECRET-NOTES'));
    expect(kept.map(([file]) => file)).toEqual([]);
  });
});

describe('the agent on a file app', () => {
  it('gets no pixels, is refused a file outside the directory by URL, and is shown nothing of one a link leads to', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) return [{ toolName: 'screenshot', input: {} }];
      if (call.turn === 2) return [{ toolName: 'navigate', input: { url: '../secret.html' } }];
      if (call.turn === 3) return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /link "Notes"/) } }];
      return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read the notes' } }];
    });
    const project = createProject({ 'tests/agent.e2e.ts': AGENT_SUITE, ...SITE });
    try {
      const outcome = await runExisting(project, { appUrl: fileUrl(project), config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } });
      expect(loopCalls).toHaveLength(4);
      // A file app's pixels can show a frame of another local file, so the model is sent none, even on request.
      expect(loopCalls.map((call) => call.imageParts)).toEqual([0, 0, 0, 0]);
      // The typed URL is the navigation rule's: the model reads the refusal and the page has not moved.
      expect(loopCalls[2]!.lastToolResult).toContain('POLICY_DENIED');
      expect(loopCalls[2]!.lastToolResult).toContain("stays in the directory of the app's file");
      // The link is the page's own, so the browser follows it; what it shows there is refused in place of the screen.
      expect(loopCalls[3]!.lastToolResult).toContain("a file app stays in the directory of the app's file");
      expect(resultByTitle(outcome, 'the agent cannot be led out of the directory').attempts).toHaveLength(1);
      for (const call of loopCalls) {
        expect([call.prompt, call.lastPrompt, ...call.toolResults].join('\n')).not.toContain('TOP-SECRET-NOTES');
      }
    } finally {
      project.cleanup();
    }
  }, 120_000);
});
