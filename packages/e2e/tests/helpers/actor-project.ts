/** What the fixture projects of the actor suites share: the sign-in setups behind an actor's `session`, and the screen every session shows. */

/** A setup test file that saves a session under each of `names`. */
export const sessionSetups = (names: readonly string[]): string => `import { test } from 'e2e';

for (const name of ${JSON.stringify(names)}) {
  test.setup('sign in as ' + name, { sessions: [name] }, async ({ app, session }) => {
    await app.open('/login');
    await session.save(name);
  });
}
`;

/** One button, for a session to act on and another to look for. */
export const sendButton = () => [{ id: 'send', role: 'button', name: 'Send' }];
