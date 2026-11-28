/**
 * The app frameworks `e2e init` recognizes, so a new config's web target
 * starts the app with its own scripts on its own port instead of a
 * placeholder URL. Each framework is a module under `frameworks/`, tried in
 * the order `FRAMEWORKS` lists them.
 */

import { nextjs } from './frameworks/nextjs.ts';
import { vite } from './frameworks/vite.ts';

/** The parts of package.json a framework reads. */
export interface FrameworkManifest {
  readonly dependencies?: Readonly<Record<string, string>> | undefined;
  readonly devDependencies?: Readonly<Record<string, string>> | undefined;
  readonly scripts?: Readonly<Record<string, string>> | undefined;
}

/** What a framework reads: package.json, and files at the project root. */
export interface Project {
  readonly manifest: FrameworkManifest;
  /** A file at the project root as text, or undefined when there is none. */
  readonly readFile: (name: string) => string | undefined;
}

/** An app init can start: the URL it answers on and the package.json scripts that serve it. */
export interface FrameworkApp {
  readonly kind: 'app';
  /** The framework's name, for the line init prints. */
  readonly framework: string;
  /** The docs page for the framework, under the docs site. */
  readonly docs: string;
  readonly url: string;
  /** The script that starts the dev server, which a local run starts or reuses. */
  readonly dev: string;
  /**
   * The production build CI tests: the script the pipeline runs before
   * `e2e run`, and the script that serves its output on the same port.
   * Absent when the project has no such scripts or they listen elsewhere,
   * and CI then starts the dev server too.
   */
  readonly production?: ProductionScripts;
}

/** A framework init found but cannot start, with the reason, so the user knows to set the target by hand. */
interface UnsupportedFramework {
  readonly kind: 'unsupported';
  readonly framework: string;
  readonly docs: string;
  readonly reason: string;
}

export type Detection = FrameworkApp | UnsupportedFramework;

/** The package.json scripts that build the production app and serve the build. */
export interface ProductionScripts {
  readonly build: string;
  readonly start: string;
}

/** One framework init can set up. */
export interface Framework {
  /** Whether the project uses this framework, from its package.json. The first framework that claims a project owns it. */
  claims(manifest: FrameworkManifest): boolean;
  /** How to start the app of a project this framework claims, or why init cannot. */
  detect(project: Project): Detection;
  /** The scripts that build and serve the production app on any port, for an existing config; only a framework with a production server has them. */
  productionScripts?(manifest: FrameworkManifest): ProductionScripts | undefined;
}

/**
 * The frameworks init tries, in order. A framework built on another one goes
 * before it: Next.js before Vite, since a Next.js app can list `vite` too.
 */
const FRAMEWORKS: readonly Framework[] = [nextjs, vite];

/** The first framework that claims the project, which answers every question about it. */
function owner(manifest: FrameworkManifest): Framework | undefined {
  return FRAMEWORKS.find((framework) => framework.claims(manifest));
}

/** How to start the app of the framework that owns the project, or undefined when no framework claims it. */
export function detectFramework(project: Project): Detection | undefined {
  return owner(project.manifest)?.detect(project);
}

/**
 * The scripts that build and serve the production app of the framework that
 * owns the project, whatever port they use, or undefined when it has none or
 * the project lacks either script. A pipeline added to an existing config
 * builds when that config runs the start script.
 */
export function productionScripts(manifest: FrameworkManifest): ProductionScripts | undefined {
  return owner(manifest)?.productionScripts?.(manifest);
}
