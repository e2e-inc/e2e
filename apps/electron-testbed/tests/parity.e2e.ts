import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from '@e2e-dev/electron';
import { expect } from 'e2e';

test.describe('what an Electron target shares with the web', () => {
  test.beforeEach(async ({ app, electron, screen }) => {
    await app.open();
    await electron.evaluate(() => (globalThis as unknown as { testbedOpen: (page: string) => Promise<void> }).testbedOpen('controls.html'));
    await expect(screen.getByRole('heading', 'Controls')).toBeVisible();
  });

  test('attaches a file from memory, which the page reads by its name and content', async ({ screen }) => {
    await screen.getByTestId('attachment').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('written in the test') });
    await expect(screen.getByTestId('attachment-count')).toHaveText('1 files');
    await expect(screen.getByTestId('attachment-text')).toHaveText('written in the test');
  });

  test('says whether an element is in the viewport, before and after scrolling to it', async ({ screen }) => {
    await expect(screen.getByRole('heading', 'Controls')).toBeInViewport();
    await expect(screen.getByTestId('far-below')).not.toBeInViewport();
    await screen.getByTestId('far-below').scrollIntoView();
    await expect(screen.getByTestId('far-below')).toBeInViewport();
    await expect(screen.getByRole('heading', 'Controls')).not.toBeInViewport();
  });

  test('goes back to the page the window showed before, and says when there is none', async ({ app, screen }) => {
    await app.back();
    await expect(screen.getByRole('heading', { name: 'Hello from e2e', level: 1 })).toBeVisible();
    const refused = await app.back().then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/no page to go back to/) });
  });

  test('records a video of the window, through a relaunch', async ({ app, screen }) => {
    await app.startRecording({ name: 'relaunch' });
    await screen.getByLabel('Budget').fill('750');
    await app.restart();
    await expect(screen.getByRole('heading', { name: 'Hello from e2e', level: 1 })).toBeVisible();
    const videos = await app.stopRecording();
    expect(videos).toHaveLength(1);
    const [video] = videos;
    if (!('path' in video)) throw new Error('the recording is a link, not a file');
    expect(video.path).toMatch(/recordings[\\/]001-relaunch\.webm$/);
    expect(existsSync(video.path)).toBe(true);
    expect(statSync(video.path).size).toBeGreaterThan(1000);
  });

  test('waits for a download and keeps the file with the attempt, and says when none starts', async ({ screen, electron }) => {
    const file = await electron.waitForDownload(() => screen.getByRole('link', 'Download note').tap());
    expect(file.suggestedFilename).toBe('note.txt');
    expect(file.path).toMatch(/^downloads\/\d+-note\.txt$/);
    expect(readFileSync(file.absolutePath, 'utf8')).toBe('downloaded note');
    const none = await electron.waitForDownload(() => Promise.resolve(), { timeout: 500 }).then(() => undefined, (error: unknown) => error);
    expect(none).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringMatching(/no download finished/) });
  });
});
