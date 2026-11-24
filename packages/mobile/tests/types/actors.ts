/** Compile-time assertions for the device `actor()`: what it holds, and that it restores no saved session. */
import { actor, test as base, type Actor, type Device } from '../../src/index.ts';

const test = base.extend({
  courier: actor({ target: 'ios-courier' }),
});

test('a device actor holds a device of its own', async ({ app, device, courier }) => {
  void (courier satisfies Actor);
  void (courier.device satisfies Device);
  void (courier.platform satisfies string);
  await app.open();
  await courier.app.open();
  await courier.agent.act('sign in as the courier');
  await courier.device.openLink('courier://orders');
  void device;
  // @ts-expect-error a device actor has no browser.
  void courier.browser;
});

// @ts-expect-error a device has no saved session to restore.
actor({ session: 'courier' });
// @ts-expect-error `targt` is not an option.
actor({ targt: 'ios' });
