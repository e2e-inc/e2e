/**
 * A first install, the way a new user meets it: packs the built `e2e`,
 * `@e2e-dev/web`, `@e2e-dev/mobile`, and `@e2e-dev/desktop`, installs them with a given pnpm
 * into a fresh project outside this repository, installs again from the
 * lockfile, typechecks a custom mobile tool, emits the declaration of a config
 * that infers its engines, and runs a TypeScript test
 * through the installed CLI. `@e2e-dev/core` is packed too and reaches the
 * project only through `e2e`'s dependency and the engines' peer, as it does
 * for a user, and the install must hold one copy of it: two would split the
 * error classes and the engine registry between the runner and the engines.
 * `@e2e-dev/util`, which core depends on, is packed with its platform
 * package for this machine, carrying the addon `pnpm run build` built here,
 * and the installed project loads it through core and round-trips a PNG.
 * A second project installs `@e2e-dev/core` and the engines without `e2e`,
 * as a program that drives a browser or device with core alone does, and
 * imports each engine's main entry there.
 *
 * pnpm 11 and later fail an install on any dependency build script the
 * project has not decided on (`ERR_PNPM_IGNORED_BUILDS`), and write a
 * `pnpm-workspace.yaml` asking for the decision. Either one fails this
 * check. `check-install-scripts.ts` names the package that would cause it;
 * this proves the install itself.
 *
 * Usage: `node scripts/install-smoke.ts <pnpm major or version>` after
 * `pnpm run build`, e.g. `node scripts/install-smoke.ts 11`. Needs the npm
 * registry for the published dependencies. Exits 1 naming what failed.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addonFile, findAddon, hostPlatform } from './native/addons.ts';
import { REPO_ROOT } from './public-packages.ts';

const pnpmVersion = process.argv[2];
if (pnpmVersion === undefined) {
  process.stderr.write('usage: node scripts/install-smoke.ts <pnpm version>\n');
  process.exit(2);
}

const util = findAddon('util');
const utilPlatforms = Object.values(util.targets);
const host = hostPlatform();
if (!utilPlatforms.includes(host)) throw new Error(`@e2e-dev/util ships no addon for ${host}`);

/**
 * The packages a new user installs: the runner and its engines, the core both build on, and core's addon with this
 * machine's platform package.
 */
const PACKAGES = ['util', `util/npm/${host}`, 'core', 'e2e', 'web', 'mobile', 'desktop', 'desktop/npm/darwin-arm64', 'desktop/npm/darwin-x64'] as const;

const root = mkdtempSync(join(tmpdir(), 'e2e-install-smoke-'));
const tarballs = join(root, 'tarballs');
const project = join(root, 'project');
const coreOnly = join(root, 'core-only');
mkdirSync(tarballs);
mkdirSync(join(project, 'tests'), { recursive: true });
mkdirSync(coreOnly);

/** Runs `command` in `cwd`; returns its exit code and combined output. */
function run(cwd: string, command: string, args: readonly string[]): { status: number; output: string } {
  // pnpm's release-age gate would block a dependency bump for a day; this check is about build scripts.
  const env = { ...process.env, E2E_TELEMETRY_DISABLED: '1', pnpm_config_minimum_release_age: '0' };
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: process.platform === 'win32' });
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const driverVersion = process.env['AGENT_DEVICE_VERSION'];
const pnpm = (args: readonly string[], cwd = project) => run(cwd, 'npx', ['--yes', `pnpm@${pnpmVersion}`, ...args]);

const mobileManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/mobile/package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const problems: string[] = [];
let workspaceYaml: string | undefined;
try {
  // The platform package carries no addon in a checkout: a copy of it gets the one `pnpm run build` placed beside the
  // loader, so a release build already placed in the package stays as it is.
  const addon = addonFile(util, host);
  const built = join(util.packageDir, addon);
  if (!existsSync(built)) throw new Error(`${built} is missing; run pnpm run build first`);
  const hostPackage = join(root, `util-${host}`);
  cpSync(join(util.packageDir, 'npm', host), hostPackage, { recursive: true });
  copyFileSync(built, join(hostPackage, addon));
  for (const name of PACKAGES) {
    const dir = name === `util/npm/${host}` ? hostPackage : join(REPO_ROOT, 'packages', name);
    const packed = run(dir, 'pnpm', ['pack', '--pack-destination', tarballs]);
    if (packed.status !== 0) throw new Error(`pnpm pack failed in packages/${name}:\n${packed.output}`);
  }
  const files = readdirSync(tarballs);
  // The version follows the prefix, so `e2e-dev-desktop-` never takes `e2e-dev-desktop-darwin-arm64-`.
  const tarball = (prefix: string): string => `file:${join(tarballs, files.find((file) => file.startsWith(prefix) && /^[\d.]/.test(file.slice(prefix.length)))!)}`;
  // `e2e` names its exact `@e2e-dev/core`, core its exact `@e2e-dev/util`, and util its platform packages, which the
  // registry has not published yet: the overrides serve the tarballs, this machine's util platform package among them.
  // So are the desktop engine's platform packages, which carry no driver when packed off a release. Off the Mac they
  // match, an install from the registry skips them by `os` and `cpu`; a skipped `file:` override breaks pnpm 11's
  // frozen reinstall instead (ENOTDIR), so there the override drops them.
  const platformPackage = (name: string, arch: string): string => (process.platform === 'darwin' && process.arch === arch ? JSON.stringify(tarball(`e2e-dev-${name}-`)) : '"-"');
  const utilOverrides = utilPlatforms.map((platform) => `  '@e2e-dev/util-${platform}': ${platform === host ? JSON.stringify(tarball(`e2e-dev-util-${platform}-`)) : '"-"'}\n`).join('');
  workspaceYaml = `overrides:\n  '@e2e-dev/core': ${JSON.stringify(tarball('e2e-dev-core-'))}\n  '@e2e-dev/util': ${JSON.stringify(tarball('e2e-dev-util-'))}\n${utilOverrides}  '@e2e-dev/desktop-darwin-arm64': ${platformPackage('desktop-darwin-arm64', 'arm64')}\n  '@e2e-dev/desktop-darwin-x64': ${platformPackage('desktop-darwin-x64', 'x64')}\n${driverVersion ? `  agent-device: ${JSON.stringify(driverVersion)}\n` : ''}`;
  writeFileSync(join(project, 'pnpm-workspace.yaml'), workspaceYaml);
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'install-smoke',
      private: true,
      type: 'module',
      devDependencies: {
        e2e: tarball('e2e-0'),
        '@e2e-dev/web': tarball('e2e-dev-web-'),
        '@e2e-dev/mobile': tarball('e2e-dev-mobile-'),
        '@e2e-dev/desktop': tarball('e2e-dev-desktop-'),
        typescript: mobileManifest.devDependencies['typescript'],
        '@types/node': mobileManifest.devDependencies['@types/node'],
        '@types/json-schema': '7.0.15',
        ai: mobileManifest.devDependencies['ai'],
        zod: mobileManifest.dependencies['zod'],
      },
    }),
  );
  writeFileSync(join(project, 'e2e.config.ts'), "import type { E2EConfig } from 'e2e';\n\nexport default { targets: [{ name: 'local', platform: 'test' }] } satisfies E2EConfig;\n");
  writeFileSync(
    join(project, 'tests', 'smoke.e2e.ts'),
    "import { expect, test } from 'e2e';\n\nenum Answer { Yes = 'yes' }\n\ntest('TypeScript runs', () => {\n  expect(Answer.Yes).toBe('yes');\n});\n",
  );

  writeFileSync(join(project, 'mobile-types.ts'), `
import { tool } from 'ai';
import { z } from 'zod';
import { defineTool } from 'e2e/agent';
import { mobile, type Device, type DeviceSessionClient } from '@e2e-dev/mobile';
import { unstable_deviceSession } from '@e2e-dev/mobile/tools';

const iphone = mobile({ platform: 'ios' });
const pixel = mobile({ platform: 'android' });
export const mobileData = defineTool(tool({
  description: 'Turn cellular mobile data on or off. Wi-Fi is not affected.',
  inputSchema: z.object({ on: z.boolean() }),
  execute: async ({ on }) => {
    const { client, selection } = unstable_deviceSession(iphone, pixel);
    await client.settings.update({ ...selection, setting: 'mobile-data', state: on ? 'on' : 'off' });
    return on ? 'mobile data is on' : 'mobile data is off';
  },
}), { mutates: true, platforms: ['android'] });

export async function checkFixture(device: Device) {
  const { client, selection } = device.unstable_raw;
  const typed: DeviceSessionClient = client;
  await typed.apps.list(selection);
  const { nodes } = await typed.capture.snapshot(selection);
  nodes.map((node) => node.identifier);
  // @ts-expect-error unknown settings are rejected.
  await typed.settings.update({ ...selection, setting: 'not-a-setting', state: 'on' });
  // @ts-expect-error unsupported states are rejected.
  await typed.settings.update({ ...selection, setting: 'mobile-data', state: 'invalid' });
  // @ts-expect-error snapshot nodes have known fields.
  nodes.map((node) => node.nonexistentField);
}
`);

  // Core's addon, reached the way core reaches it: through e2e, then core, since pnpm links neither at the top.
  writeFileSync(join(project, 'util-addon.mjs'), `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const core = createRequire(createRequire(import.meta.url).resolve('e2e')).resolve('@e2e-dev/core');
const util = await import(pathToFileURL(createRequire(core).resolve('@e2e-dev/util')).href);
const back = await util.decodePng(await util.NativeImage.fromRgba(new Uint8Array(16).fill(200), 2, 2).encode());
if (back.width !== 2 || back.pixels()[0] !== 200) throw new Error('the installed addon changed a PNG round trip');
`);

  // pnpm links `@e2e-dev/core` only inside the engines' own folders, so a
  // declaration that names a core type has no path this project can import (TS2883).
  writeFileSync(join(project, 'engines.config.ts'), `
import { desktop } from '@e2e-dev/desktop';
import { mobile } from '@e2e-dev/mobile';
import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';

export default {
  targets: [
    { name: 'web', engine: web() },
    { name: 'ios', engine: mobile({ platform: 'ios' }) },
    { name: 'mac', engine: desktop() },
  ],
} satisfies E2EConfig;
`);

  for (const [step, args] of [
    ['pnpm install', ['install']],
    ['pnpm install --frozen-lockfile', ['install', '--frozen-lockfile']],
    ['mobile tool types', ['exec', 'tsc', '--noEmit', '--strict', '--types', 'node,json-schema', '--module', 'NodeNext', '--target', 'ES2024', 'mobile-types.ts']],
    ['config declaration', ['exec', 'tsc', '--declaration', '--emitDeclarationOnly', '--outDir', 'types', '--strict', '--skipLibCheck', '--types', 'node', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--target', 'ES2024', 'engines.config.ts']],
    ['e2e run', ['exec', 'e2e', 'run', '--workers', '1']],
    [`@e2e-dev/util-${host} loads`, ['exec', 'node', 'util-addon.mjs']],
  ] as const) {
    const { status, output } = pnpm(args);
    process.stdout.write(`$ ${step}: exit ${status}\n`);
    if (status !== 0) problems.push(`${step} exited ${status}:\n${output}`);
    if (output.includes('ERR_PNPM_IGNORED_BUILDS')) problems.push(`${step} reported ERR_PNPM_IGNORED_BUILDS:\n${output}`);
    if (existsSync(join(project, 'pnpm-workspace.yaml')) && readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8') !== workspaceYaml) {
      problems.push(`${step} wrote or changed pnpm-workspace.yaml`);
    }
    if (problems.length > 0) break;
    if (args[0] === 'install') {
      const copies = readdirSync(join(project, 'node_modules', '.pnpm')).filter((dir) => dir.startsWith('@e2e-dev+core@'));
      if (copies.length !== 1) problems.push(`${step} installed ${copies.length} copies of @e2e-dev/core: ${copies.join(', ')}`);
    }
    if (driverVersion && args[0] === 'install') {
      const graph = pnpm(['list', 'agent-device', '--depth', 'Infinity', '--json']);
      const versions: string[] = [];
      /** Collects driver copies without confusing their parents' versions. */
      function collect(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (key === 'agent-device') versions.push(child.version);
          collect(child);
        }
      }
      collect(JSON.parse(graph.output));
      if (graph.status !== 0 || versions.length === 0 || versions.some((version) => version !== driverVersion)) {
        throw new Error(`Expected agent-device ${driverVersion}: ${graph.output}`);
      }
    }
  }

  if (problems.length === 0) {
    writeFileSync(join(coreOnly, 'pnpm-workspace.yaml'), workspaceYaml);
    writeFileSync(
      join(coreOnly, 'package.json'),
      JSON.stringify({
        name: 'install-smoke-core-only',
        private: true,
        type: 'module',
        dependencies: { '@e2e-dev/core': tarball('e2e-dev-core-'), '@e2e-dev/web': tarball('e2e-dev-web-'), '@e2e-dev/mobile': tarball('e2e-dev-mobile-'), '@e2e-dev/desktop': tarball('e2e-dev-desktop-') },
      }),
    );
    writeFileSync(join(coreOnly, 'main-entries.mjs'), `
for (const [name, factory, options] of [['@e2e-dev/web', 'web', undefined], ['@e2e-dev/mobile', 'mobile', { platform: 'ios' }], ['@e2e-dev/desktop', 'desktop', undefined]]) {
  const entry = await import(name);
  entry[factory](options);
  try {
    entry.test('needs the runner', () => {});
    throw new Error(name + ': test() ran without e2e installed');
  } catch (error) {
    if (error.code !== 'RUNNER_NOT_INSTALLED') throw error;
  }
}
`);
    for (const [step, args] of [
      ['core-only pnpm install', ['install']],
      ['core-only main entries', ['exec', 'node', 'main-entries.mjs']],
    ] as const) {
      const { status, output } = pnpm(args, coreOnly);
      process.stdout.write(`$ ${step}: exit ${status}\n`);
      if (status !== 0) problems.push(`${step} exited ${status}:\n${output}`);
      if (problems.length > 0) break;
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`install smoke: pnpm ${pnpmVersion} installs ${PACKAGES.join(', ')} with no build scripts, typechecks a mobile tool, emits a config's declaration, runs a TypeScript test, loads core's addon, and loads the engines' main entries without e2e\n`);
}
