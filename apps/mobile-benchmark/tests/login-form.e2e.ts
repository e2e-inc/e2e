import { credentials } from 'e2e';
import type { Credential } from 'e2e';
import { expect, openScenario, test } from './fixtures.ts';

test.describe('login form', () => {
  // The scenario's hardcoded account, declared once in e2e.config.ts. Every
  // "valid" value below comes from here; only the invalid ones are literals.
  let account: Credential;

  test.beforeEach(async ({ app, device, screen }) => {
    account = credentials.user('benchmark');
    await openScenario({ app, device, screen }, 'Login Form');
  });

  // With the keyboard open, iOS spends the first tap on dismissing it, and
  // an iPhone keyboard has no dismiss key, so Return on the last field (which
  // blurs a single-line input) dismisses it before every submit.
  test('rejects a malformed email', async ({ screen }) => {
    await screen.getByTestId('email-input').fill('not-an-email');
    await screen.getByTestId('password-input').fill(account.password);
    await screen.getByTestId('password-input').press('Enter');
    await screen.getByTestId('login-button').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Enter a valid email address');
  });

  test('rejects an unknown account', async ({ screen }) => {
    await screen.getByTestId('email-input').fill('someone@example.com');
    await screen.getByTestId('password-input').fill(account.password);
    await screen.getByTestId('password-input').press('Enter');
    await screen.getByTestId('login-button').tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Invalid credentials');
  });

  test('signs in and logs out', async ({ screen }) => {
    await screen.getByTestId('email-input').fill(account.username);
    await screen.getByTestId('password-input').fill(account.password);
    await screen.getByTestId('password-input').press('Enter');
    await screen.getByTestId('login-button').tap();
    // Submitting a secure field makes iOS offer to save the password in a
    // sheet hosted by Safari over the app, a moment after the logged-in
    // screen is up. It is not an alert to the engine, but its buttons are in
    // the tree, and while it is up the app's are not. Android offers nothing,
    // so the wait for the sheet is bounded.
    const notNow = screen.getByRole('button', 'Not Now');
    const offered = await notNow.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (offered) await notNow.tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Logged in successfully');

    await screen.getByTestId('logout-button').tap();
    await expect(screen.getByTestId('login-button')).toBeVisible();
  });

  // An iOS simulator's simctl capture is portrait whatever the orientation,
  // and the engine does not read which way the image is turned, so the
  // password field's mask has no place on a landscape screenshot: it is
  // withheld. Once the engine masks a turned image in place, this test
  // changes with it.
  test('withholds a landscape screenshot of the password field', { platforms: ['ios'] }, async ({ app, device, screen }) => {
    await device.setOrientation('landscape-left');
    try {
      await expect.poll(async () => {
        const viewport = await device.viewport();
        return viewport.width > viewport.height;
      }).toBe(true);
      await expect(screen.getByTestId('password-input')).toBeVisible();
      const refused = await app.screenshot('landscape').then(() => undefined, (error: unknown) => error);
      expect(refused).toHaveProperty('code', 'POLICY_DENIED');
    } finally {
      await device.setOrientation('portrait');
      await expect.poll(async () => {
        const viewport = await device.viewport();
        return viewport.height > viewport.width;
      }).toBe(true);
    }
    await expect(screen.getByTestId('login-button')).toBeVisible();
  });
});
