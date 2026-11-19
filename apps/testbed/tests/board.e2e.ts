import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserName, failure } from './helpers.ts';

test('hover reveals the card menu action', async ({ app, screen }) => {
  await app.open('/board');

  await screen.getByText('Card actions', { exact: true }).hover();
  await screen.getByRole('button', 'Archive card').tap();

  await expect(screen.getByLabel('Board state')).toHaveText('Design review is archived');
});

test('setInputFiles resolves paths from the project root', async ({ app, screen }) => {
  await app.open('/board');

  await screen.getByLabel('Attachment').setInputFiles('fixtures/attachment.txt');

  await expect(screen.getByLabel('Attachment state')).toHaveText('attachment.txt');
});

test('dragging the card marks it done', { requires: ['browser'] }, async ({ app, screen, browser }) => {
  await app.open('/board');

  const drag = () => screen.getByText('Design review', { exact: true }).dragTo(screen.getByLabel('Done column'));
  if (await browserName(browser) === 'firefox') {
    // Firefox's remote agent drops no HTML5 drag (https://bugzilla.mozilla.org/show_bug.cgi?id=1515879).
    expect(await failure(drag)).toHaveProperty('code', 'UNSUPPORTED_CAPABILITY');
    return;
  }
  await drag();

  await expect(screen.getByLabel('Board state')).toHaveText('Design review is done');
});
