/**
 * Actors: more sessions in one test, beside the test's own. An engine
 * package exports `actor()`, built here, and a project declares each actor
 * as a fixture: `test.extend({ reviewer: actor({ session: 'reviewer' }) })`.
 * The fixture carries what it declares as data, so the runner knows, before
 * anything runs, which saved sessions and which targets a test needs.
 */

import { actorBrand } from '../internal/brands.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { rejectUnknownKeys } from '../internal/options.ts';
import type { ActorOptions, FixtureFn } from '../types/fixtures.ts';

/** What an `actor()` fixture declares, as the runner reads it. */
export interface ActorDeclaration {
  /** The engine whose package exported the `actor()`: the engine the actor's target must run. */
  readonly engine: string;
  /** The saved session the actor starts from; undefined for a signed-out one. */
  readonly session: string | undefined;
  /** The target the actor runs on; undefined for the test's own. */
  readonly target: string | undefined;
}

const OPTION_KEYS = ['session', 'target'] as const satisfies readonly (keyof ActorOptions)[];

/**
 * The `actor()` of the engine named `engine`, for its package to export.
 * `Value` is what a test receives for the actor: `app`, `screen`, and
 * `agent`, and the fixtures the engine contributes. `Options` narrows what
 * the engine's actors take: one that cannot restore a saved session leaves
 * `session` out.
 */
export function defineActor<Value, Options extends ActorOptions = ActorOptions>(engine: string): (options?: Options) => FixtureFn<{}, Value> {
  return (options) => {
    const given: ActorOptions = options ?? {};
    if (typeof given !== 'object' || given === null || Array.isArray(given)) {
      throw new ConfigurationError('INVALID_CONFIG', 'actor() takes an options object: { session?, target? }');
    }
    rejectUnknownKeys('actor()', given, OPTION_KEYS);
    for (const key of OPTION_KEYS) {
      const value: unknown = given[key];
      if (value !== undefined && (typeof value !== 'string' || value === '')) {
        const what = key === 'session' ? 'the name of a session a setup test saves' : 'the name of a target of the config';
        throw new ConfigurationError('INVALID_CONFIG', `actor({ ${key} }) must be ${what}`);
      }
    }
    const declaration: ActorDeclaration = Object.freeze({ engine, session: given.session, target: given.target });
    // The runner opens an actor itself and never calls this. A runner that
    // predates actors reads it as an ordinary fixture and fails here, by name.
    const fixture: FixtureFn<{}, Value> = async ({}, _use) => {
      throw new ConfigurationError('UNSUPPORTED_CAPABILITY', 'actor() is a fixture for test.extend(), and this version of e2e does not open actors: update e2e');
    };
    return Object.defineProperty(fixture, actorBrand, { value: declaration });
  };
}

/** What `value` declares when it is an `actor()` fixture, of any installed copy of this package; undefined for anything else. */
export function actorDeclaration(value: unknown): ActorDeclaration | undefined {
  if (typeof value !== 'function') return undefined;
  const declaration = (value as { readonly [actorBrand]?: unknown })[actorBrand];
  if (typeof declaration !== 'object' || declaration === null) return undefined;
  const { engine, session, target } = declaration as Partial<Record<keyof ActorDeclaration, unknown>>;
  if (typeof engine !== 'string') return undefined;
  return {
    engine,
    session: typeof session === 'string' ? session : undefined,
    target: typeof target === 'string' ? target : undefined,
  };
}
