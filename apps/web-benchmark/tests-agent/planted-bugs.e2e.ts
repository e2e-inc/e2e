/**
 * Bug-book scenarios: each has one planted product bug, and an `agent.assert`
 * of the correct behavior must fail on it. A passing judgment here is a missed
 * bug, so the test asserts on the failure. An act that runs into the bug on
 * its way and reports it counts too: the agent caught it either way.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { UNRECORDED } from './recordings.ts';

/** Whether the flow reported the product misbehaving, as an act verdict or a judgment. */
async function caughtTheBug(flow: () => Promise<void>): Promise<boolean> {
  try {
    await flow();
    return false;
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    return code === 'ASSERTION_FAILED' || code === 'ACTION_FAILED';
  }
}

test('cart totals: a judgment catches the stale order summary', async ({ app, agent }) => {
  await app.open('/e/cart-totals');
  const caught = await caughtTheBug(async () => {
    await agent.act('increase the quantity of the first item in the cart by two');
    await agent.assert('the subtotal and the order total in the summary equal the sum of the line totals');
  });
  expect(caught).toBe(true);
});

test('checkout review: a judgment catches the broken copy', async ({ app, agent }) => {
  await app.open('/e/checkout-review');
  const caught = await caughtTheBug(() =>
    agent.assert('the greeting addresses the customer by a real first name and the delivery estimate names a date'),
  );
  expect(caught).toBe(true);
});

test('wishlist: a judgment catches the lost saved items', async ({ app, agent }) => {
  await app.open('/e/wishlist');
  const caught = await caughtTheBug(async () => {
    await agent.act('save the first product to the wishlist, then open the wishlist tab');
    await agent.assert('the wishlist tab lists the product that was just saved');
  });
  expect(caught).toBe(true);
});

// The two bugs below show only across views: a judgment of one screen passes
// over them. Each test credits a caught bug only once the deterministic checks
// prove the flow reached the screen that shows it, so an agent that gave up
// early earns nothing.

test(
  'profile settings: the flow catches the name that was never stored',
  { skip: UNRECORDED },
  async ({ app, agent, screen }) => {
    await app.open('/e/profile-settings');
    const caught = await caughtTheBug(async () => {
      await agent.act(
        'change the display name to Jordan Rivera, save the profile, and confirm on the public profile that the new name took effect',
      );
    });
    await expect(screen.getByTestId('header-name')).toHaveText('Signed in as Jordan Rivera');
    await expect(screen.getByRole('tab', 'Public profile')).toHaveAttribute('aria-selected', 'true');
    expect(caught).toBe(true);
  },
);

test(
  'audit log: the flow catches the event missing between pages',
  { skip: UNRECORDED },
  async ({ app, agent, screen }) => {
    await app.open('/e/audit-log');
    const caught = await caughtTheBug(async () => {
      await agent.act('go to page 2 of the audit log and check that it continues exactly where page 1 ended, with no event number missing');
    });
    await expect(screen.getByTestId('page-range')).not.toContainText('page 1 of 5');
    expect(caught).toBe(true);
  },
);
