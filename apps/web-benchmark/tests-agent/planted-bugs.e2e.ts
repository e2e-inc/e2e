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

/**
 * Runs the act that only reaches the decisive view; true when the act reported
 * the bug on its own (an agent that notices it while getting there). The
 * caller still checks the view, so a flow that broke on the way earns nothing.
 * Such a run leaves no recording for the act, since only a passing step is
 * recorded.
 */
async function actReportedBug(act: () => Promise<unknown>): Promise<boolean> {
  try {
    await act();
    return false;
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === 'ASSERTION_FAILED' || code === 'ACTION_FAILED') return true;
    throw cause;
  }
}

/** Whether a judgment failed, the verdict that counts as catching the bug below. */
async function judgmentFails(judgment: () => Promise<void>): Promise<boolean> {
  try {
    await judgment();
    return false;
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ASSERTION_FAILED') return true;
    throw cause;
  }
}

// The two bugs below show only on a second view of the data. Each test splits
// the flow in three: an act that only gets to that view (it passes, so a keyed
// run records it), deterministic checks that the view is the decisive one, and
// a judgment there, whose failure is credit. An act that reports the bug on
// its own counts too, once the checks show it reached the view. A flow that
// broke on the way fails the test instead of earning it. Each has a healthy twin on the same
// page, where the judgment must pass, so calling everything broken scores
// nothing.

test(
  'profile settings: a judgment catches the name that was never stored',
  { skip: UNRECORDED },
  async ({ app, agent, screen }) => {
    await app.open('/e/profile-settings');
    const reported = await actReportedBug(() =>
      agent.act('change the display name to Jordan Rivera, save the profile, then open the Public profile tab'),
    );
    await expect(screen.getByTestId('header-name')).toHaveText('Signed in as Jordan Rivera');
    await expect(screen.getByRole('tab', 'Public profile')).toHaveAttribute('aria-selected', 'true');
    const caught =
      reported || (await judgmentFails(() => agent.assert('the public profile shows the display name that was just saved, Jordan Rivera')));
    expect(caught).toBe(true);
  },
);

test(
  'profile settings: a judgment confirms the time zone that was stored',
  { skip: UNRECORDED },
  async ({ app, agent, screen }) => {
    await app.open('/e/profile-settings');
    await agent.act('change the time zone to Asia/Tokyo, save the profile, then open the Public profile tab');
    await expect(screen.getByTestId('public-zone')).toHaveText('Asia/Tokyo');
    await agent.assert('the public profile shows the time zone that was just saved, Asia/Tokyo');
  },
);

test(
  'audit log: a judgment catches the event missing from page 2',
  { skip: UNRECORDED },
  async ({ app, agent, screen }) => {
    await app.open('/e/audit-log');
    const reported = await actReportedBug(() => agent.act('open page 2 of the audit log'));
    await expect(screen.getByTestId('page-range')).toContainText('page 2 of 5');
    const caught =
      reported ||
      (await judgmentFails(() =>
        agent.assert(
          'the events are numbered #47 (newest) down to #1, and this page lists exactly the events its footer range names, none missing',
        ),
      ));
    expect(caught).toBe(true);
  },
);

test(
  'audit log: a judgment confirms a page that matches its footer',
  { skip: UNRECORDED },
  async ({ app, agent, screen }) => {
    await app.open('/e/audit-log');
    await agent.act('open page 4 of the audit log');
    await expect(screen.getByTestId('page-range')).toContainText('page 4 of 5');
    await agent.assert(
      'the events are numbered #47 (newest) down to #1, and this page lists exactly the events its footer range names, none missing',
    );
  },
);
