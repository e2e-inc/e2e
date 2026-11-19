/**
 * The readers' script is self-contained: a function serialized into the page
 * reaches nothing but its parameters, its locals, and page globals. A
 * reference to an import or to a module-scope binding typechecks and lints,
 * and would otherwise fail only in a browser.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readerCall, readerInstallCall, READERS_INIT_SCRIPT } from '../../src/in-page/readers.ts';

const IN_PAGE = fileURLToPath(new URL('../../src/in-page/', import.meta.url));

/** The modules `readers.ts` splices a function of into the script, by file name. */
function splicedModules(): string[] {
  const wiring = readFileSync(path.join(IN_PAGE, 'readers.ts'), 'utf8');
  return [...wiring.matchAll(/^import .* from '\.\/([\w-]+\.ts)';$/gm)].map((match) => match[1]!);
}

/**
 * The names `sources` use that are neither bound in them nor a global of a
 * page: what the TypeScript compiler cannot find when it checks each as a
 * script of its own, with the DOM's globals and none of Node's.
 */
function unboundNames(sources: Readonly<Record<string, string>>): string[] {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-readers-script-'));
  try {
    for (const [name, source] of Object.entries(sources)) writeFileSync(path.join(directory, `${name}.js`), source);
    const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
    const files = Object.keys(sources).map((name) => `${name}.js`);
    const checked = spawnSync(process.execPath, [tsc, '--noEmit', '--allowJs', '--checkJs', '--target', 'esnext', '--lib', 'esnext,dom,dom.iterable', '--types', '', ...files], { cwd: directory, encoding: 'utf8' });
    if (checked.error !== undefined) throw checked.error;
    const report = `${checked.stdout}${checked.stderr}`;
    return [...report.matchAll(/^(\S+)\.js\(\d+,\d+\): error TS\d+: (?:Cannot find name|No value exists in scope for the shorthand property) '([^']+)'/gm)].map((match) => `${match[1]!}: ${match[2]!}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the readers\' script', () => {
  it('splices only functions of modules that import types alone', () => {
    // `dom.ts` imports the closed-roots key for `withDom`; `createDom` itself is held by the next test.
    const modules = splicedModules().filter((name) => name !== 'dom.ts');
    expect(modules).toEqual(expect.arrayContaining(['create-readers.ts', 'read-semantics.ts', 'roles.ts', 'accessible-name.ts', 'locator-match.ts', 'select-chain.ts', 'modal-dialogs.ts']));
    for (const name of modules) {
      const valueImports = readFileSync(path.join(IN_PAGE, name), 'utf8').match(/^import (?!type )[^;]*;/gm) ?? [];
      expect(valueImports, name).toEqual([]);
    }
  });

  it('names nothing but its own bindings and page globals', () => {
    expect(unboundNames({
      // The detector's own check: an import, a module-scope binding, and a Node global each count as unbound.
      control: 'const read = (element) => [__vite_ssr_import_0__.selectChain(element), MAX_OPTIONS, process.env, document.title];',
      preload: READERS_INIT_SCRIPT,
      call: `const call = ${readerCall('tree')};`,
      install: `const install = ${readerInstallCall('tree')};`,
    })).toEqual(['control: __vite_ssr_import_0__', 'control: MAX_OPTIONS', 'control: process']);
  });
});
