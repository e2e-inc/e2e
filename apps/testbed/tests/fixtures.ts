import { randomUUID } from 'node:crypto';
import { test as base, actor, type Actor } from '@e2e-dev/web';

/** The playground's users beside the test's own. An actor is opened only for a test that names it. */
const withActors = base.extend({
  reviewer: actor({ session: 'reviewer' }),
  guest: actor(),
  secondWindow: actor({ session: 'admin' }),
});

export const test = withActors.extend<{ room: string }>({
  /** A room of its own for the test, which the test's user and the reviewer both have open. */
  room: async ({ app, reviewer }, use) => {
    const room = `/room?id=${randomUUID()}`;
    await app.open(room);
    await reviewer.app.open(room);
    await use(room);
  },
});

/** Posts a note as whoever `who` is: the test's own user, or an actor. */
export async function postNote(who: Pick<Actor, 'screen'>, text: string): Promise<void> {
  await who.screen.getByLabel('Note').fill(text);
  await who.screen.getByRole('button', 'Post').tap();
}
