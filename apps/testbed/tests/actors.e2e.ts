import { randomUUID } from 'node:crypto';
import { expect } from 'e2e';
import { postNote, test } from './fixtures.ts';

test.describe('actors', () => {
  test('a note one user posts shows up for the other', { session: 'admin' }, async ({ app, screen, reviewer }) => {
    const room = `/room?id=${randomUUID()}`;
    await app.open(room);
    await reviewer.app.open(room);
    await expect(screen.getByRole('status', 'Viewer')).toHaveText('Signed in as admin');
    await expect(reviewer.screen.getByRole('status', 'Viewer')).toHaveText('Signed in as reviewer');

    await postNote({ screen }, 'ship it');

    await expect(reviewer.screen.getByText('admin: ship it')).toBeVisible();
    await expect(reviewer.browser).toHaveURL(room);
    expect(reviewer.platform).toBe('web');
    // An actor has the test's HTTP client too, its calls told under the actor's name.
    const notes = await reviewer.request.get(room.replace('/room', '/api/room'));
    expect(await notes.json()).toEqual([{ author: 'admin', text: 'ship it' }]);
  });

  test('a fixture opens the room for both users', { session: 'admin' }, async ({ screen, reviewer, room }) => {
    await expect(reviewer.browser).toHaveURL(room);
    await postNote(reviewer, 'looks good');

    await expect(screen.getByText('reviewer: looks good')).toBeVisible();
  });

  test('a signed-out guest reads along', { session: 'admin' }, async ({ screen, guest, room }) => {
    await guest.app.open(room);
    await expect(guest.screen.getByRole('status', 'Viewer')).toHaveText('Viewing as a guest');

    await postNote({ screen }, 'for everyone');
    await postNote(guest, 'hello');

    await expect(guest.screen.getByText('admin: for everyone')).toBeVisible();
    await expect(screen.getByText('guest: hello')).toBeVisible();
  });

  test('three users post at once', { session: 'admin' }, async ({ screen, reviewer, guest, room }) => {
    await guest.app.open(room);

    await Promise.all([postNote({ screen }, 'one'), postNote(reviewer, 'two'), postNote(guest, 'three')]);

    for (const who of [screen, reviewer.screen, guest.screen]) {
      await expect(who.getByRole('list', 'Notes').getByRole('listitem')).toHaveCount(3);
    }
  });

  test('the same account in a second window keeps its own storage', { session: 'admin' }, async ({ app, browser, secondWindow }) => {
    await app.open('/dashboard');
    await secondWindow.app.open('/dashboard');
    await expect(secondWindow.screen.getByRole('status', 'Greeting')).toContainText('admin');

    await browser.evaluate(() => {
      localStorage.setItem('draft', 'mine');
      return null;
    });

    expect(await browser.evaluate(() => localStorage.getItem('draft'))).toBe('mine');
    expect(await secondWindow.browser.evaluate(() => localStorage.getItem('draft'))).toBeNull();
  });

  test('signing out in one window leaves the other signed in', { session: 'admin' }, async ({ app, screen, browser, secondWindow }) => {
    await app.open('/dashboard');
    await secondWindow.app.open('/dashboard');

    await screen.getByRole('link', 'Sign out').tap();

    await expect(browser).toHaveURL('/login');
    await secondWindow.app.open('/dashboard');
    await expect(secondWindow.browser).toHaveURL('/dashboard');
  });

  test('a test without a session of its own drives two actors', async ({ reviewer, guest }) => {
    const room = `/room?id=${randomUUID()}`;
    await reviewer.app.open(room);
    await guest.app.open(room);

    await postNote(reviewer, 'from the reviewer');

    await expect(guest.screen.getByText('reviewer: from the reviewer')).toBeVisible();
  });

  test.describe('in hooks', () => {
    test.beforeEach(async ({ reviewer }) => {
      await reviewer.app.open('/dashboard');
    });

    test.afterEach(async ({ reviewer }) => {
      await expect(reviewer.browser).toHaveURL('/dashboard');
    });

    test('a hook opens the page an actor starts on', async ({ reviewer }) => {
      await expect(reviewer.screen.getByRole('status', 'Greeting')).toContainText('reviewer');
    });
  });
});
