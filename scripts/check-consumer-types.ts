/**
 * Fails when the declarations `@e2e-dev/web` publishes do not compile in a
 * project that installed it.
 *
 * A declaration file keeps the type imports of its source, so a type from a
 * devDependency compiles on this checkout, where the workspace links it, and
 * is `TS2307` in a user's project with `skipLibCheck: false`, or `any` with
 * it on. This packs `@e2e-dev/web` and the workspace packages a test project
 * installs with it, unpacks them into a project under the OS temp directory,
 * links beside each one only its `dependencies` and required peers, as an
 * install does, and compiles a test file against them with
 * `skipLibCheck: false`. Nothing comes from the registry: the linked
 * packages are the ones this workspace installed.
 *
 * Usage: `node scripts/check-consumer-types.ts` after `pnpm run build`, part
 * of `pnpm check`. Exits 1 with the compiler's errors.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './public-packages.ts';

/** The directories under `packages/` of `@e2e-dev/web` and of the workspace packages a test project installs with it. */
const PACKAGES = ['core', 'e2e', 'web'] as const;

/** What a project that tests a web app compiles: the engine in its config, a test on the `browser` fixture, and an attach outside any test. */
const CONSUMER = `import { expect, type E2EConfig } from 'e2e';
import {
  attachBrowser,
  test,
  web,
  type AttachedBrowser,
  type Browser,
  type BrowserProvider,
  type BrowserTab,
  type Cookie,
  type Dialog,
  type WebOptions,
  type WebResponse,
  type WebRoute,
} from '@e2e-dev/web';

const provider: BrowserProvider = {
  name: 'hosted',
  acquire: async () => ({ id: 'lease', cdpEndpoint: 'ws://127.0.0.1:9222' }),
  release: async () => undefined,
};
const options: WebOptions = { browser: provider, viewport: { width: 1280, height: 720 } };
export default { targets: [{ name: 'web', engine: web(options), app: { url: 'http://127.0.0.1:3000' } }] } satisfies E2EConfig;

test('signs in', async ({ browser, screen, app }) => {
  const cookie: Cookie = { name: 'session', value: 'token', url: app.baseUrl };
  await browser.setCookies([cookie]);
  // @ts-expect-error a cookie names its site by url or by domain, never both.
  await browser.setCookies([{ name: 'session', value: 'token', url: app.baseUrl, domain: 'example.com' }]);
  await browser.onDialog((dialog: Dialog) => dialog.accept());
  await browser.route('**/api/**', (route: WebRoute) => route.continue());
  const response: WebResponse = await browser.waitForResponse('**/api/session');
  // @ts-expect-error a response status is a number.
  void (response.status satisfies string);
  const tab: BrowserTab = await browser.newTab();
  await tab.close();
  await expect(screen.getByRole('heading')).toBeVisible();
});

/** Reads the title of the tab open in a browser that is already running. */
export async function title(cdpEndpoint: string): Promise<string> {
  await using attached: AttachedBrowser = await attachBrowser(cdpEndpoint, { timeout: 10_000 });
  const browser: Browser = attached.browser;
  return browser.title();
}
`;

/** A strict NodeNext project that checks every declaration file it loads. */
const TSCONFIG = {
  compilerOptions: { target: 'ES2024', module: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] },
  files: ['consumer.ts'],
};

interface PackedManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

/** Runs `command` in `cwd`; returns its exit code and combined output. */
function run(cwd: string, command: string, args: readonly string[]): { status: number; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

/** Links the package directory `target` as `path`. */
function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'junction');
}

/**
 * Packs `packages/<dir>` into `tarballs` and unpacks it under its own name
 * in `modules`, as an install lays it out; returns the manifest it publishes.
 */
function unpack(dir: string, tarballs: string, modules: string): PackedManifest {
  const source = join(REPO_ROOT, 'packages', dir);
  const before = new Set(readdirSync(tarballs));
  const packed = run(source, 'pnpm', ['pack', '--pack-destination', tarballs]);
  const tarball = readdirSync(tarballs).find((file) => !before.has(file));
  if (packed.status !== 0 || tarball === undefined) throw new Error(`pnpm pack failed in packages/${dir}:\n${packed.output}`);
  const { name } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as PackedManifest;
  const destination = join(modules, name);
  mkdirSync(destination, { recursive: true });
  const extracted = run(destination, 'tar', ['-xzf', join(tarballs, tarball), '--strip-components=1']);
  if (extracted.status !== 0) throw new Error(`could not unpack ${tarball}:\n${extracted.output}`);
  return JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8')) as PackedManifest;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-consumer-types-')));
const tarballs = join(root, 'tarballs');
const project = join(root, 'project');
const modules = join(project, 'node_modules');
let errors: string | undefined;
try {
  mkdirSync(tarballs);
  mkdirSync(modules, { recursive: true });
  const unpacked = PACKAGES.map((dir) => ({ dir, manifest: unpack(dir, tarballs, modules) }));
  const names = new Set(unpacked.map(({ manifest }) => manifest.name));
  for (const { dir, manifest } of unpacked) {
    const requiredPeers = Object.keys(manifest.peerDependencies ?? {}).filter((peer) => manifest.peerDependenciesMeta?.[peer]?.optional !== true);
    for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...requiredPeers]) {
      if (names.has(dependency)) continue;
      const installed = join(REPO_ROOT, 'packages', dir, 'node_modules', dependency);
      if (!existsSync(installed)) throw new Error(`${manifest.name} needs ${dependency}, which packages/${dir}/node_modules does not hold; run \`pnpm install\``);
      link(installed, join(modules, manifest.name, 'node_modules', dependency));
    }
  }
  link(join(REPO_ROOT, 'node_modules', '@types', 'node'), join(modules, '@types', 'node'));
  writeFileSync(join(project, 'consumer.ts'), CONSUMER);
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify(TSCONFIG));
  const compiled = run(project, process.execPath, [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', project]);
  if (compiled.status !== 0) errors = compiled.output;
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (errors !== undefined) {
  process.stderr.write(`a project that installs @e2e-dev/web does not compile with skipLibCheck: false:\n${errors}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`consumer types: a project compiles against the packed ${PACKAGES.join(', ')} with skipLibCheck: false\n`);
}
