import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('audit log', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/audit-log');
  });

  test('page 1 lists the ten newest events', async ({ screen }) => {
    const rows = screen.getByRole('table', 'Audit log').getByRole('row');
    await expect(rows).toHaveCount(11);
    await expect(rows.nth(1)).toContainText('#47');
    await expect(rows.last()).toContainText('#38');
    await expect(screen.getByTestId('page-range')).toHaveText('Showing 1-10 of 47 · page 1 of 5');
    await expect(screen.getByRole('button', 'Previous')).toBeDisabled();
  });

  test('page 2 starts at #36, so #37 is on no page (planted bug)', async ({ screen }) => {
    const rows = screen.getByRole('table', 'Audit log').getByRole('row');
    await screen.getByRole('button', 'Next').tap();
    await expect(screen.getByTestId('page-range')).toHaveText('Showing 11-20 of 47 · page 2 of 5');
    await expect(rows.nth(1)).toContainText('#36');
    await expect(screen.getByTestId('event-37')).toBeHidden();

    for (let page = 3; page <= 5; page += 1) {
      await screen.getByRole('button', 'Next').tap();
      await expect(screen.getByTestId('page-range')).toContainText(`page ${page} of 5`);
      await expect(screen.getByTestId('event-37')).toBeHidden();
    }
    await expect(rows).toHaveCount(7);
    await expect(rows.last()).toContainText('#1');
    await expect(screen.getByRole('button', 'Next')).toBeDisabled();
  });
});
