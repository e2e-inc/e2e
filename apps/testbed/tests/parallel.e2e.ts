import { expect, test } from 'e2e';

test.describe.configure({ parallel: true });

for (const title of ['opens the todos', 'opens the todos again']) {
  test(title, { tags: ['parallel'] }, async ({ app, screen }) => {
    await app.open('/todos');
    await expect(screen.getByLabel('New todo')).toBeVisible();
  });
}

test.describe('in order', { parallel: false, tags: ['parallel'] }, () => {
  let added = false;

  test('adds a todo', async ({ app, screen }) => {
    await app.open('/todos');
    await screen.getByLabel('New todo').fill('Run in order');
    await screen.getByLabel('New todo').press('Enter');
    await expect(screen.getByTestId('todo')).toContainText(['Run in order']);
    added = true;
  });

  test('runs after it, in the same import of the file', () => {
    expect(added).toBe(true);
  });
});
