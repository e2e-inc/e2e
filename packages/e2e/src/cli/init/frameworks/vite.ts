/**
 * Vite: the dev server, locally and in CI, on the `--port` of the `vite`
 * command, else 5173. A root `vite.config.*` that sets another port keeps the
 * placeholder. Vite reads no `PORT` variable, and `vite preview` serves the
 * build on 4173, so CI runs `dev` too.
 */

import type { Detection, Framework } from '../frameworks.ts';
import { declares, DEV_SCRIPT, fixedPort, launchedCommands } from './scripts.ts';

const NAME = 'Vite';
const DOCS = '/reference/cli#vite-apps';
const DEFAULT_PORT = 5173;
/** `vite` subcommands that start no dev server. */
const OTHER_COMMANDS = new Set(['build', 'preview', 'optimize']);
/** The dev server's options that take a value, so the word after one is not the root it serves. */
const VALUE_OPTIONS = new Set(['--host', '--port', '--open', '--base', '-l', '--logLevel', '-m', '--mode', '-d', '--debug', '-f', '--filter', '--configLoader', '--profile']);
/** The dev server's boolean options, which take `true` or `false` as a value (`--clearScreen false`) and any other word as the root. */
const BOOLEAN_OPTIONS = new Set(['--clearScreen', '--cors', '--strictPort', '--force', '--experimentalBundle']);
/** Vite plugins of a backend that serves the app, while Vite serves only its assets. */
const BACKEND_PLUGINS = ['laravel-vite-plugin', 'vite-plugin-symfony', 'vite-plugin-ruby', 'vite-plugin-rails'];
/** Root files of Laravel and Django, whose Vite integrations list no plugin in package.json. */
const BACKEND_FILES = ['artisan', 'manage.py'];
/** Vite plugins that serve the dev server over HTTPS, where init writes an `http` URL. */
const HTTPS_PLUGINS = ['@vitejs/plugin-basic-ssl', 'vite-plugin-mkcert'];
const CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.cts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
/** Every `port` key in a config, as `port: 3000`, `port: env.PORT`, or the shorthand `{ port }`. */
const CONFIG_PORT = /\bport\b(?:\s*:\s*([^,}\n]*))?/gu;
/** An `https` key in a config, as `https: { ... }` or the shorthand `{ https }`, and not `https: false` or an `https://` URL. */
const CONFIG_HTTPS = /\bhttps\s*(?::(?!\/\/|\s*false\b)|[,}])/u;

export const vite: Framework = {
  /** A project with `vite` in `dependencies` or `devDependencies`. */
  claims: (manifest) => declares(manifest, 'vite'),

  /**
   * How to start the app. `unsupported` when init cannot tell where it
   * answers: a backend serves it, the dev server serves HTTPS, the `dev`
   * script starts no Vite dev server, serves another directory or names its
   * own config, or the port is not a fixed number init can read.
   */
  detect({ manifest, readFile }): Detection {
    const unsupported = (reason: string): Detection => ({ kind: 'unsupported', framework: NAME, docs: DOCS, reason });
    const backend = BACKEND_PLUGINS.find((name) => declares(manifest, name)) ?? BACKEND_FILES.find((name) => readFile(name) !== undefined);
    if (backend !== undefined) return unsupported(`${backend} marks a backend that serves the app, and the Vite dev server serves its assets`);
    const configs = CONFIGS.flatMap((name) => {
      const text = readFile(name);
      return text === undefined ? [] : [{ name, code: withoutComments(text) }];
    });
    const https = HTTPS_PLUGINS.find((name) => declares(manifest, name)) ?? configs.find(({ code }) => CONFIG_HTTPS.test(code))?.name;
    if (https !== undefined) return unsupported(`${https} serves the Vite dev server over HTTPS`);
    const dev = manifest.scripts?.[DEV_SCRIPT];
    if (dev === undefined) return unsupported(`package.json has no ${DEV_SCRIPT} script`);
    const commands = launchedCommands(dev);
    const server = commands.findIndex((command) => command[0] === 'vite' && !OTHER_COMMANDS.has(command[1] ?? ''));
    const command = commands[server];
    if (command === undefined) return unsupported(`the ${DEV_SCRIPT} script does not start the Vite dev server`);
    const options = command[1] === 'dev' || command[1] === 'serve' ? command.slice(2) : command.slice(1);
    // Vite's CLI ignores what follows `--`.
    const end = options.indexOf('--');
    const args = end === -1 ? options : options.slice(0, end);
    if (args.some((word) => word === '-c' || word === '--config' || word.startsWith('--config='))) {
      return unsupported(`the ${DEV_SCRIPT} script names its own Vite config`);
    }
    // Vite reads the config of the directory it serves, which init does not.
    const root = args.some((word, index) => !word.startsWith('-') && !isOptionValue(args[index - 1] ?? '', word));
    if (root || commands.slice(0, server).some((earlier) => earlier[0] === 'cd')) {
      return unsupported(`the ${DEV_SCRIPT} script serves another directory`);
    }
    const flag = portFlag(args);
    const port = flag === undefined ? DEFAULT_PORT : fixedPort(flag);
    if (port === undefined) return unsupported(`init cannot read a fixed port from the ${DEV_SCRIPT} script`);
    // `--port` wins over the config's port.
    const config = flag === undefined ? configs.find(({ code }) => namesOtherPort(code, port))?.name : undefined;
    if (config !== undefined) return unsupported(`${config} sets a port other than ${port}`);
    return { kind: 'app', framework: NAME, docs: DOCS, url: `http://localhost:${port}`, dev: DEV_SCRIPT };
  },
};

/** Whether `word` is the value of `option`, the word before it, rather than the root the dev server serves. */
function isOptionValue(option: string, word: string): boolean {
  return VALUE_OPTIONS.has(option) || (BOOLEAN_OPTIONS.has(option) && (word === 'true' || word === 'false'));
}

/** The value of a `--port` option (`--port 4100`, `--port=4100`), the only form Vite's CLI takes, raw. */
function portFlag(args: readonly string[]): string | undefined {
  for (const [index, word] of args.entries()) {
    if (word === '--port') return args[index + 1] ?? '';
    if (word.startsWith('--port=')) return word.slice('--port='.length);
  }
  return undefined;
}

/** A config's code without its `/* *\/` and `//` comments; a `//` inside a word or a string, as in `'//cdn'` or `https://`, stays. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|\s)\/\/.*$/gmu, '$1');
}

/**
 * Whether a config's code names a port other than `port`, or one init cannot
 * read: any `port` key counts, `preview` and `hmr` ones too, so a config that
 * only repeats the dev port (`server: { port: 5173, strictPort: true }`) is
 * the one that keeps it.
 */
function namesOtherPort(code: string, port: number): boolean {
  return [...code.matchAll(CONFIG_PORT)].some((match) => match[1]?.trim() !== String(port));
}
