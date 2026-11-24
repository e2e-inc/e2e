import { test, expect } from 'e2e';

test('filters the shop to items under $20', { session: 'customer' }, async ({ app, agent, screen }) => {
  const results = screen.getByRole('status', 'Results');
  await app.open('/shop');
  await results.waitFor();

  await agent.act('show only items under $20');

  await expect(results).toHaveText('2 items under $20');
  await expect(screen.getByRole('list', 'Products').getByRole('listitem')).toHaveText([
    'Canvas Tote, $14',
    'Steel Bottle, $18',
  ]);
});
