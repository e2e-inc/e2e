/** Next.js: `next dev` locally, and `next start` on the production build in CI when it serves the dev port. */

import type { Detection, Framework, FrameworkManifest, ProductionScripts } from '../frameworks.ts';
import { commandsOf, declares, DEV_SCRIPT, fixedPort } from './scripts.ts';

const NAME = 'Next.js';
const DOCS = '/frameworks/nextjs';
const DEFAULT_PORT = 3000;
const BUILD_SCRIPT = 'build';
const START_SCRIPT = 'start';
const PORT_FLAGS = new Set(['--port', '-p']);

export const nextjs: Framework = {
  /** A project with `next` in `dependencies` or `devDependencies`. */
  claims: (manifest) => declares(manifest, 'next'),

  /** How to start the app. A project with no `dev` script, or a `dev` script whose port init cannot read as a fixed number, is `unsupported`. */
  detect({ manifest }): Detection {
    const scripts = manifest.scripts ?? {};
    const dev = scripts[DEV_SCRIPT];
    if (dev === undefined) {
      return { kind: 'unsupported', framework: NAME, docs: DOCS, reason: `package.json has no ${DEV_SCRIPT} script` };
    }
    const port = scriptPort(dev);
    if (port === undefined) {
      return { kind: 'unsupported', framework: NAME, docs: DOCS, reason: `init cannot read a fixed port from the ${DEV_SCRIPT} script` };
    }
    const start = scripts[START_SCRIPT];
    const production = scripts[BUILD_SCRIPT] !== undefined && start !== undefined && scriptPort(start) === port;
    return {
      kind: 'app',
      framework: NAME,
      docs: DOCS,
      // localhost, never 127.0.0.1: Next.js 16 dev blocks cross-origin dev resources, so a 127.0.0.1 page renders but never hydrates.
      url: `http://localhost:${port}`,
      dev: DEV_SCRIPT,
      ...(production ? { production: { build: BUILD_SCRIPT, start: START_SCRIPT } } : {}),
    };
  },

  productionScripts(manifest: FrameworkManifest): ProductionScripts | undefined {
    const scripts = manifest.scripts ?? {};
    return scripts[BUILD_SCRIPT] === undefined || scripts[START_SCRIPT] === undefined ? undefined : { build: BUILD_SCRIPT, start: START_SCRIPT };
  },
};

/**
 * The port one command sets: the value of its `--port` or `-p` flag
 * (`--port 3100`, `--port=3100`, `-p 3100`, `-p3100`), else a `PORT=`
 * variable, else undefined. The value is raw, so `$PORT` stays as written.
 */
function portSetting(tokens: readonly string[]): string | undefined {
  let variable: string | undefined;
  for (const [index, token] of tokens.entries()) {
    const flag = PORT_FLAGS.has(token)
      ? tokens[index + 1] ?? ''
      : /^--port=(.*)$/u.exec(token)?.[1] ?? /^-p(\d.*)$/u.exec(token)?.[1];
    if (flag !== undefined) return flag;
    variable ??= /^PORT=(.*)$/u.exec(token)?.[1];
  }
  return variable;
}

/**
 * The port a script's server listens on, read from the command that runs
 * `next` (`node check.js -p 8080 && next dev`), else 3000. Undefined when
 * init cannot write the port into `app.url`: a value that is not a fixed
 * port, such as `$PORT` or `0`, or a port another command in the script
 * sets, which may or may not reach the server. A script that never runs
 * `next`, such as `turbo run dev`, is read as one command.
 */
function scriptPort(script: string): number | undefined {
  const commands = commandsOf(script);
  const server = commands.findIndex((command) => command.includes('next'));
  if (server !== -1 && commands.some((command, index) => index !== server && portSetting(command) !== undefined)) return undefined;
  const value = portSetting(server === -1 ? commands.flat() : commands[server] ?? []);
  return value === undefined ? DEFAULT_PORT : fixedPort(value);
}
