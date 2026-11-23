/** `toHaveValue` on nodes that are not form controls, through the public locator and matcher on a real page. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';

const PAGE = [
  '<div role="slider" aria-label="Volume" aria-valuenow="50" tabindex="0"></div>',
  '<div role="slider" aria-label="Power" aria-valuenow="1" aria-valuetext="On" tabindex="0"></div>',
  '<div role="spinbutton" aria-label="Seats" aria-valuenow="3" tabindex="0"></div>',
  '<div role="progressbar" aria-label="Upload" aria-valuenow="40"></div>',
  '<progress aria-label="Download" value="7" max="10"></progress>',
  '<meter aria-label="Disk" value="0.5"></meter>',
  '<input type="range" aria-label="Native" value="30" aria-valuetext="Thirty">',
  '<div role="progressbar" aria-label="Pending"></div>',
  '<div role="progressbar" aria-label="Blank" aria-valuenow=""></div>',
  '<progress aria-label="Over" value="20" max="10"></progress>',
  '<progress aria-label="Invalid" value="abc"></progress>',
  '<meter aria-label="Full" value="150" max="100"></meter>',
  '<div role="slider" aria-label="Blank text" aria-valuenow="50" aria-valuetext="" tabindex="0"></div>',
  '<div role="spinbutton" aria-label="Month" contenteditable aria-valuenow="5" aria-valuetext="May">05</div>',
  '<div role="scrollbar" aria-label="Page" aria-controls="x" aria-valuenow="20" tabindex="0"></div>',
  '<progress aria-label="Indeterminate"></progress>',
].join('');

test('reads range widgets', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('50');
  await expect(screen.getByRole('slider', { name: 'Power' })).toHaveValue('On');
  await expect(screen.getByRole('spinbutton', { name: 'Seats' })).toHaveValue('3');
  await expect(screen.getByRole('progressbar', { name: 'Upload' })).toHaveValue('40');
  await expect(screen.getByRole('progressbar', { name: 'Download' })).toHaveValue('7');
  await expect(screen.getByRole('meter', { name: 'Disk' })).toHaveValue('0.5');
  await expect(screen.getByRole('slider', { name: 'Native' })).toHaveValue('30');
  await expect(screen.getByRole('progressbar', { name: 'Over' })).toHaveValue('10');
  await expect(screen.getByRole('progressbar', { name: 'Invalid' })).toHaveValue('0');
  await expect(screen.getByRole('meter', { name: 'Full' })).toHaveValue('100');
  await expect(screen.getByRole('slider', { name: 'Blank text' })).toHaveValue('50');
  await expect(screen.getByRole('spinbutton', { name: 'Month' })).toHaveValue('05');
  await expect(screen.getByRole('scrollbar', { name: 'Page' })).toHaveValue('20');
  await expect(screen.getByRole('slider', { name: 'Volume' })).not.toHaveValue('51');
  expect(await screen.getByRole('slider', { name: 'Power' }).inputValue()).toBe('On');
});

test('still refuses a range widget with no value', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('progressbar', { name: 'Pending' })).toHaveValue('', { timeout: 300 });
});

test('still refuses a range widget with a blank value', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('progressbar', { name: 'Blank' })).toHaveValue('', { timeout: 300 });
  await expect(screen.getByRole('progressbar', { name: 'Indeterminate' })).toHaveValue('', { timeout: 300 });
});
`;

describe('toHaveValue outside form controls', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/values.e2e.ts': SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('reads a range widget, keeps a native input, and refuses a widget with no value', async () => {
    const outcome = await runExisting(project, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'] as const } });
    const read = resultByTitle(outcome, 'reads range widgets');
    expect(read.attempts.at(-1)?.error, JSON.stringify(read.attempts.at(-1)?.error)).toBeUndefined();
    expect(read.status).toBe('passed');
    const refused = resultByTitle(outcome, 'still refuses a range widget with no value');
    expect(refused.status).toBe('failed');
    expect(refused.attempts.at(-1)?.error?.message).toContain('no value (not a form control)');
    const blank = resultByTitle(outcome, 'still refuses a range widget with a blank value');
    expect(blank.status).toBe('failed');
    expect(blank.attempts.at(-1)?.error?.message).toContain('no value (not a form control)');
  }, 120_000);
});
