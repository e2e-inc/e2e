import { test, expect } from 'e2e';

// Two users in one test: the signed-in admin posts, and a second user, in a
// browser of its own and signed out, sees the post on the shared board.
test('a message the admin posts reaches a signed-out user', { session: 'admin', peers: { guest: {} } }, async ({ app, screen, peers }) => {
  await app.open('/messages');
  await expect(screen.getByRole('status', 'Signed in as')).toHaveText('admin');
  await screen.getByLabel('Message').fill('Standup moved to 10:30');
  await screen.getByRole('button', 'Post').tap();
  await expect(screen.getByRole('list', 'Messages')).toContainText('admin: Standup moved to 10:30');

  await peers.guest.app.open('/messages');
  await expect(peers.guest.screen.getByRole('status', 'Signed in as')).toHaveText('guest');
  await expect(peers.guest.screen.getByRole('list', 'Messages')).toContainText('admin: Standup moved to 10:30');
});
