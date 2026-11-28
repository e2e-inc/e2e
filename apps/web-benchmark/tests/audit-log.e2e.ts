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

  test('page 2 starts at #36 and lists nine events, so #37 is on no page (planted bug)', async ({ screen }) => {
    const rows = screen.getByRole('table', 'Audit log').getByRole('row');
    await screen.getByRole('button', 'Next').tap();
    await expect(screen.getByTestId('page-range')).toHaveText('Showing 11-20 of 47 · page 2 of 5');
    await expect(rows).toHaveCount(10);
    await expect(rows.nth(1)).toContainText('#36');
    await expect(rows.last()).toContainText('#28');
    await expect(screen.getByTestId('event-37')).toBeHidden();
  });

  test('the other pages match their footers', async ({ screen }) => {
    const rows = screen.getByRole('table', 'Audit log').getByRole('row');
    const expected = [
      { page: 3, range: '21-30', first: '#27', last: '#18', count: 11 },
      { page: 4, range: '31-40', first: '#17', last: '#8', count: 11 },
      { page: 5, range: '41-47', first: '#7', last: '#1', count: 8 },
    ];
    await screen.getByRole('button', 'Next').tap();
    for (const { page, range, first, last, count } of expected) {
      await screen.getByRole('button', 'Next').tap();
      await expect(screen.getByTestId('page-range')).toHaveText(`Showing ${range} of 47 · page ${page} of 5`);
      await expect(rows).toHaveCount(count);
      await expect(rows.nth(1)).toContainText(first);
      await expect(rows.last()).toContainText(last);
    }
    await expect(screen.getByRole('button', 'Next')).toBeDisabled();
  });
});
