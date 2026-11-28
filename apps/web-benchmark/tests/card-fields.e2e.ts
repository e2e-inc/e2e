import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('card fields', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/card-fields');
  });

  test('each field reformats, focus moves to the next frame, and Pay enables', async ({ screen, browser }) => {
    const number = browser.frameLocator('iframe[title="Secure card number input"]').getByLabel('Card number');
    const expiry = browser.frameLocator('iframe[title="Secure expiration date input"]').getByLabel('Expiration (MM / YY)');
    const cvc = browser.frameLocator('iframe[title="Secure CVC input"]').getByLabel('Security code');
    const pay = screen.getByRole('button', 'Pay $96.00');

    await expect(pay).toBeDisabled();
    await number.fill('4242424242424242');
    await expect(number).toHaveValue('4242 4242 4242 4242');
    await expect(expiry).toBeFocused();

    await expiry.fill('1234');
    await expect(expiry).toHaveValue('12 / 34');
    await expect(cvc).toBeFocused();

    await cvc.fill('123');
    await expect(pay).toBeEnabled();
    await pay.tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Payment authorized for card ending 4242');
    await expect(screen.getByTestId('card-checkout')).toHaveAttribute('data-charged', '4242 12 / 34 123');
  });

  test('a number that fails the checksum keeps Pay disabled', async ({ screen, browser }) => {
    const frame = browser.frameLocator('iframe[title="Secure card number input"]');
    await frame.getByLabel('Card number').fill('4242424242424241');
    await expect(frame.getByRole('alert')).toHaveText('Your card number is invalid.');
    await browser.frameLocator('iframe[title="Secure expiration date input"]').getByLabel('Expiration (MM / YY)').fill('1234');
    await browser.frameLocator('iframe[title="Secure CVC input"]').getByLabel('Security code').fill('123');
    await expect(screen.getByRole('button', 'Pay $96.00')).toBeDisabled();
  });

  test('an expired date is refused in its frame', async ({ browser }) => {
    const frame = browser.frameLocator('iframe[title="Secure expiration date input"]');
    await frame.getByLabel('Expiration (MM / YY)').fill('0125');
    await expect(frame.getByRole('alert')).toHaveText("Your card's expiration date is in the past.");
  });

  test('the page cannot read inside the sandboxed frames', async ({ browser }) => {
    const readable = await browser.evaluate(() =>
      [...document.querySelectorAll('iframe')].map((frame) => {
        try {
          return frame.contentDocument !== null;
        } catch {
          return false;
        }
      }),
    );
    expect(readable).toEqual([false, false, false]);
  });
});
