/**
 * The app frameworks `e2e init` recognizes in a project's package.json, so a
 * new config's web target starts the app with its own scripts on its own
 * port instead of a placeholder URL. Next.js is the one detector today; a
 * framework such as Vite or Astro adds an entry to `DETECTORS` with the same shape.
 */

/** The parts of package.json a detector reads. */
export interface FrameworkManifest {
  readonly dependencies?: Readonly<Record<string, string>> | undefined;
  readonly devDependencies?: Readonly<Record<string, string>> | undefined;
  readonly scripts?: Readonly<Record<string, string>> | undefined;
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
  readonly production?: { readonly build: string; readonly start: string };
}

/** A framework init found but cannot start, with the reason, so the user knows to set the target by hand. */
interface UnsupportedFramework {
  readonly kind: 'unsupported';
  readonly framework: string;
  readonly docs: string;
  readonly reason: string;
}

type Detection = FrameworkApp | UnsupportedFramework;

interface FrameworkDetector {
  readonly name: string;
  readonly docs: string;
  /** The package whose dependency marks the framework. */
  readonly dependency: string;
  /** The port the dev server and the production server listen on when their scripts set none. */
  readonly defaultPort: number;
}

const DETECTORS: readonly FrameworkDetector[] = [
  { name: 'Next.js', docs: '/frameworks/nextjs', dependency: 'next', defaultPort: 3000 },
];

const DEV_SCRIPT = 'dev';
const BUILD_SCRIPT = 'build';
const START_SCRIPT = 'start';

/**
 * The framework the project's package.json declares in `dependencies` or
 * `devDependencies`, with how to start it, or undefined when it declares
 * none init knows. A project with the framework but no `dev` script, or a
 * `dev` script whose port is not a number, is `unsupported`.
 */
export function detectFramework(manifest: FrameworkManifest): Detection | undefined {
  const detector = DETECTORS.find(({ dependency }) =>
    manifest.dependencies?.[dependency] !== undefined || manifest.devDependencies?.[dependency] !== undefined);
  if (detector === undefined) return undefined;
  const scripts = manifest.scripts ?? {};
  const dev = scripts[DEV_SCRIPT];
  if (dev === undefined) {
    return { kind: 'unsupported', framework: detector.name, docs: detector.docs, reason: `package.json has no ${DEV_SCRIPT} script` };
  }
  const port = scriptPort(dev, detector.defaultPort);
  if (port === undefined) {
    return { kind: 'unsupported', framework: detector.name, docs: detector.docs, reason: `the port in the ${DEV_SCRIPT} script is not a fixed number` };
  }
  const start = scripts[START_SCRIPT];
  const production = scripts[BUILD_SCRIPT] !== undefined && start !== undefined && scriptPort(start, detector.defaultPort) === port;
  return {
    kind: 'app',
    framework: detector.name,
    docs: detector.docs,
    // localhost, never 127.0.0.1: Next.js 16 dev blocks cross-origin dev resources, so a 127.0.0.1 page renders but never hydrates.
    url: `http://localhost:${port}`,
    dev: DEV_SCRIPT,
    ...(production ? { production: { build: BUILD_SCRIPT, start: START_SCRIPT } } : {}),
  };
}

const PORT_FLAGS = new Set(['--port', '-p']);

/**
 * The port a script's server listens on: the value of its `--port` or `-p`
 * flag (`--port 3100`, `--port=3100`, `-p 3100`, `-p3100`), else a `PORT=`
 * variable it sets, else `fallback`. Undefined when the value is not a fixed
 * port, such as `$PORT` or `0`, which init cannot write into `app.url`.
 */
function scriptPort(script: string, fallback: number): number | undefined {
  const tokens = script.split(/\s+/u).map((token) => token.replace(/^["']|["']$/gu, '')).filter((token) => token !== '');
  let flag: string | undefined;
  let variable: string | undefined;
  for (const [index, token] of tokens.entries()) {
    const value = PORT_FLAGS.has(token)
      ? tokens[index + 1] ?? ''
      : /^--port=(.*)$/u.exec(token)?.[1] ?? /^-p(\d.*)$/u.exec(token)?.[1];
    if (value !== undefined) {
      flag ??= value;
      continue;
    }
    variable ??= /^PORT=(.*)$/u.exec(token)?.[1];
  }
  const value = flag ?? variable;
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : undefined;
}
