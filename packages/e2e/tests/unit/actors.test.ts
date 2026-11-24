/** `actor()` as an engine package builds it: what it carries for the runner, and what it refuses. */

import { describe, expect, it } from 'vitest';
import { actorDeclaration } from '@e2e-dev/core/lib/engine/actor';
import { fakeActor } from '../helpers/fake-engine.ts';

describe('actor()', () => {
  it('carries what it declares for the runner to read', () => {
    expect(actorDeclaration(fakeActor({ session: 'reviewer', target: 'phone' }))).toEqual({ engine: 'fake', session: 'reviewer', target: 'phone' });
    expect(actorDeclaration(fakeActor())).toEqual({ engine: 'fake', session: undefined, target: undefined });
  });

  it('is not what an ordinary fixture function is', () => {
    expect(actorDeclaration(async () => undefined)).toBeUndefined();
    expect(actorDeclaration({ engine: 'fake' })).toBeUndefined();
    expect(actorDeclaration(undefined)).toBeUndefined();
  });

  it('fails by name when a runner that predates actors calls it as a fixture', async () => {
    await expect(fakeActor()({}, async () => undefined)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('this version of e2e does not open actors'),
    });
  });

  it.each([
    [{ sesion: 'reviewer' }, /actor\(\) has unknown key "sesion"/],
    [{ session: '' }, /actor\(\{ session \}\) must be the name of a session a setup test saves/],
    [{ session: 1 }, /actor\(\{ session \}\) must be the name of a session a setup test saves/],
    [{ target: '' }, /actor\(\{ target \}\) must be the name of a target of the config/],
    [[], /actor\(\) takes an options object: \{ session\?, target\? \}/],
  ])('refuses %j', (options, message) => {
    expect(() => fakeActor(options as never)).toThrow(message);
  });
});
