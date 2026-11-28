import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('profile settings', () => {
  test.beforeEach(async ({ app, screen }) => {
    await app.open('/e/profile-settings');
    await expect(screen.getByLabel('Display name')).toBeEnabled();
  });

  test('the time zone is saved: the public profile and a reload show it', async ({ app, screen }) => {
    await screen.getByLabel('Time zone').selectOption({ value: 'Asia/Tokyo' });
    await screen.getByRole('button', 'Save changes').tap();
    await expect(screen.getByTestId('toast')).toHaveText('Profile saved');

    await screen.getByRole('tab', 'Public profile').tap();
    await expect(screen.getByTestId('public-zone')).toHaveText('Asia/Tokyo');

    await app.open('/e/profile-settings');
    await expect(screen.getByLabel('Display name')).toBeEnabled();
    await expect(screen.getByLabel('Time zone')).toHaveValue('Asia/Tokyo');
  });

  test('an empty name is refused', async ({ screen }) => {
    await screen.getByLabel('Display name').fill('   ');
    await screen.getByRole('button', 'Save changes').tap();
    await expect(screen.getByTestId('toast')).toHaveText('Display name cannot be empty');
    await expect(screen.getByTestId('header-name')).toHaveText('Signed in as Jordan Lee');
  });

  test('a saved name shows in the header but not on the public profile or after a reload (planted bug)', async ({ app, screen }) => {
    await screen.getByLabel('Display name').fill('Jordan Rivera');
    await screen.getByRole('button', 'Save changes').tap();
    await expect(screen.getByTestId('toast')).toHaveText('Profile saved');
    await expect(screen.getByTestId('header-name')).toHaveText('Signed in as Jordan Rivera');

    await screen.getByRole('tab', 'Public profile').tap();
    await expect(screen.getByTestId('public-name')).toHaveText('Jordan Lee');

    await app.open('/e/profile-settings');
    await expect(screen.getByLabel('Display name')).toBeEnabled();
    await expect(screen.getByTestId('header-name')).toHaveText('Signed in as Jordan Lee');
    await expect(screen.getByLabel('Display name')).toHaveValue('Jordan Lee');
  });
});
