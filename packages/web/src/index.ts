/**
 * `@e2e-dev/web` public surface: the `web()` engine factory, the `browser`
 * fixture types, and `test`, `describe`, and the hooks typed with that
 * fixture, so a test file registers from one import. `expect`,
 * `credentials`, and `secrets` come from `e2e` itself. Without `e2e`
 * installed, `web()` still loads and `test` throws when used.
 */

import { defineActor } from '@e2e-dev/core/engine';
import type { Actor as RunnerActor } from 'e2e';
import type { WebFixtures } from './fixtures.ts';
import { runnerTest } from './runner-test.ts';

export * from './engine-entry.ts';
/** The engine factory as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { default } from './engine-entry.ts';

/**
 * `test` typed with this engine's contributed `browser` fixture and its
 * `app`. The same runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = runnerTest().extend<WebFixtures>();

/** `describe` and the hooks, the same functions as `test.describe` and `test.beforeEach`, typed with the `browser` fixture. */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;

/** What a test receives for a browser actor: `agent`, `app`, `screen`, `platform`, and `browser`, over a browser context of its own. */
export type Actor = RunnerActor<WebFixtures>;

/**
 * One more browser session in a test, as a fixture: another signed-in user,
 * a guest, the same account in a second window. It gets a browser context
 * of its own in the test's browser, opened only for a test that names it.
 *
 *   const test = base.extend({ reviewer: actor({ session: 'reviewer' }) });
 *
 * `session` restores a login a setup test saved. `target` names another
 * `web()` target of the config for the actor to run on.
 */
export const actor = defineActor<Actor>('web');
