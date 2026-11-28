import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('team directory', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/team-directory');
  });

  test('two members share the name and every row has the same button names', async ({ screen }) => {
    await expect(screen.getByRole('cell', 'Alex Kim')).toHaveCount(2);
    await expect(screen.getByRole('button', 'Suspend')).toHaveCount(6);
  });

  test('suspends the Toronto Alex Kim by matching the office column', async ({ screen }) => {
    const row = screen.getByRole('row').filter({ has: screen.getByRole('cell', 'Alex Kim') }).filter({ hasText: 'Toronto' });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', 'Suspend').tap();
    await expect(row).toContainText('Suspended');
    await expect(screen.getByTestId('team-directory')).toHaveAttribute('data-changed-others', '');
    await expect(screen.getByTestId('success-message')).toHaveText('Suspended akim@acme.test only');
  });

  test('the first match by name is the wrong member', async ({ screen }) => {
    await screen.getByRole('row').filter({ has: screen.getByRole('cell', 'Alex Kim') }).first().getByRole('button', 'Suspend').tap();
    await expect(screen.getByTestId('team-directory')).toHaveAttribute('data-changed-others', 'alex.kim@acme.test');
    await expect(screen.getByTestId('success-message')).toBeHidden();
  });

  test('undoing a wrong change restores the success path', async ({ screen }) => {
    const berlin = screen.getByTestId('member-m2');
    await berlin.getByRole('button', 'Suspend').tap();
    await expect(screen.getByTestId('team-directory')).toHaveAttribute('data-changed-others', 'alex.kim@acme.test');
    await berlin.getByRole('button', 'Reactivate').tap();
    await screen.getByTestId('member-m4').getByRole('button', 'Suspend').tap();
    await expect(screen.getByTestId('team-directory')).toHaveAttribute('data-changed-others', '');
    await expect(screen.getByTestId('success-message')).toHaveText('Suspended akim@acme.test only');
  });

  test('removing a member asks first and counts as a change', async ({ screen }) => {
    await screen.getByTestId('member-m6').getByRole('button', 'Remove').tap();
    await expect(screen.getByRole('dialog', 'Remove member')).toContainText('Remove alexa@acme.test?');
    await screen.getByRole('button', 'Remove member').tap();
    await expect(screen.getByTestId('member-m6')).toBeHidden();
    await expect(screen.getByTestId('team-directory')).toHaveAttribute('data-changed-others', 'alexa@acme.test');
  });
});
