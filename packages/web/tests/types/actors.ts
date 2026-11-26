/** Compile-time assertions for `actor()`: what `test.extend()` infers for it, what an actor holds, and what it refuses. */
import { expect } from 'e2e';
import { actor, test as base, type Actor, type Browser, type WebApp } from '../../src/index.ts';

// Actors alone need no type arguments: each is inferred from its `actor()`.
const test = base.extend({
  reviewer: actor({ session: 'reviewer' }),
  guest: actor(),
  desk: actor({ target: 'admin-console' }),
});

test('an actor holds what the test holds for its own session', { session: 'author' }, async ({ app, screen, reviewer, guest, desk }) => {
  void (reviewer satisfies Actor);
  void (reviewer.browser satisfies Browser);
  void (reviewer.app satisfies WebApp);
  void (`${reviewer.app.baseUrl}/api` satisfies string);
  void (reviewer.platform satisfies string);
  await reviewer.agent.act('approve the request');
  await expect(reviewer.screen.getByText('Approved')).toBeVisible();
  await expect(reviewer.browser).toHaveURL('/b/1');
  await Promise.all([app.open('/b/1'), reviewer.app.open('/b/1'), guest.app.open('/b/1')]);

  // An actor on another web target of the config is typed the same.
  void (desk.browser satisfies Browser);
  // @ts-expect-error a browser actor has no device.
  void reviewer.device;
  // @ts-expect-error `admin` was not declared.
  void (screen satisfies { admin: unknown });
});

// @ts-expect-error a test names only the actors its `test` declares.
test('names an actor nobody declared', async ({ admin }) => void admin);

// A helper written for the test's own fixtures takes an actor, and the other way round.
async function openBoard(who: Pick<Actor, 'app' | 'screen'>): Promise<void> {
  await who.app.open('/b/1');
  await who.screen.getByRole('heading', 'Board').waitFor();
}
test('one helper for every session', async ({ app, screen, reviewer }) => {
  await openBoard({ app, screen });
  await openBoard(reviewer);
});

// A fixture that names an actor takes type arguments, like any fixture that names another.
base.extend<{ reviewer: Actor; board: string }>({
  reviewer: actor({ session: 'reviewer' }),
  board: async ({ app, reviewer }, use) => {
    await app.open('/b/1');
    await reviewer.app.open('/b/1');
    await use('/b/1');
  },
});

// An actor fixture is extended like any other: inside, its name is the actor.
test.extend({
  reviewer: async ({ reviewer }, use) => {
    await reviewer.app.open('/b/1');
    await use(reviewer);
  },
});

// Hooks and describes name actors like tests do.
test.describe('board', () => {
  test.beforeEach(async ({ reviewer }) => {
    await reviewer.app.open('/b/1');
  });
  // @ts-expect-error an actor is opened for one test: a suite hook sees worker fixtures only.
  test.beforeAll(async ({ reviewer }) => void reviewer);
});

// @ts-expect-error `sesion` is not an option.
actor({ sesion: 'reviewer' });
// @ts-expect-error a session is named by a string.
actor({ session: 1 });
// @ts-expect-error an actor cannot take the name of a built-in fixture.
base.extend({ app: actor() });
