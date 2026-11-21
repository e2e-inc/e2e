/**
 * `@e2e-dev/revyl/web` public surface: `revylWeb()`, an engine that runs web
 * tests in Revyl's hosted browsers through Revyl's HTTP API. Its types never
 * reference `@e2e-dev/mobile` or `@e2e-dev/web`.
 */

export { revylWeb } from './web/engine.ts';
export type { RevylWebOptions } from './web/engine.ts';
