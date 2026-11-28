import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('increments the ArkUI counter', async ({ app, screen }) => {
  await app.open();
  const counter = screen.getByTestId('counterValue');
  await expect(counter).toHaveText('计数：0');
  await screen.getByRole('button', '加一').tap();
  await expect(counter).toHaveText('计数：1');
  await app.screenshot('counter-after-tap');
});
