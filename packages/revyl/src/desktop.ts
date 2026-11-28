/**
 * `@e2e-dev/revyl/desktop` public surface: `revylDesktop()`, the desktop
 * engine on a Revyl Mac computer. Its types never reference
 * `@e2e-dev/mobile` or `@e2e-dev/web`, so a project installs only the
 * engine it uses.
 */

export { revylDesktop } from './desktop/engine.ts';
export type { RevylDesktopOptions } from './desktop/engine.ts';
