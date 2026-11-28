import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

it.each(['a', 'b'] as const)('reads config edits across physical installs when %s installs the loader first', (first) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-host-loader-'));
  try {
    for (const name of ['a', 'b']) {
      const install = path.join(dir, name, 'node_modules', 'e2e');
      mkdirSync(install, { recursive: true });
      cpSync(path.join(packageRoot, 'dist'), path.join(install, 'dist'), { recursive: true });
      cpSync(path.join(packageRoot, 'package.json'), path.join(install, 'package.json'));
      symlinkSync(path.join(packageRoot, 'node_modules'), path.join(install, 'node_modules'), 'junction');
      writeFileSync(path.join(dir, name, 'client.mjs'), "export { openHost } from 'e2e/runner';");
    }
    const engine = new URL('../helpers/fake-engine.ts', import.meta.url).href;
    for (const name of ['primer', 'consumer']) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, 'name.mjs'), "export const name = 'one';");
      writeFileSync(path.join(dir, name, 'e2e.config.mjs'), `
import { name } from './name.mjs';
import { createFakeEngine, FAKE_APP } from ${JSON.stringify(engine)};
export default { targets: [{ name, platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }] };
`);
    }
    const second = first === 'a' ? 'b' : 'a';
    writeFileSync(path.join(dir, 'probe.mjs'), `
import { writeFileSync } from 'node:fs';
import path from 'node:path';

async function target(openHost, name) {
  const host = await openHost({ cwd: path.resolve(name), env: {} });
  try { return host.target; } finally { await host.close(); }
}

const { openHost: first } = await import('./${first}/client.mjs');
const results = [await target(first, 'primer')];
const { openHost: second } = await import('./${second}/client.mjs');
results.push(await target(second, 'consumer'));
writeFileSync('consumer/name.mjs', "export const name = 'two';");
results.push(await target(second, 'consumer'));
writeFileSync('consumer/name.mjs', "export const name = 'three';");
results.push(await target(first, 'consumer'));
console.log(JSON.stringify(results));
`);
    const actual = execFileSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    expect(JSON.parse(actual)).toEqual(['one', 'one', 'two', 'three']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);

it.each([
  ['fragment', 'before'],
  ['fragment', 'after'],
  ['query', 'before'],
  ['query', 'after'],
  ['parameter', 'before'],
  ['parameter', 'after'],
] as const)('reloads config dependencies and compiler options with a hook that adds a %s, registered %s the loader', (added, order) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-host-fragment-hook-'));
  try {
    const runner = new URL('../../dist/runner.js', import.meta.url).href;
    const engine = new URL('../helpers/fake-engine.ts', import.meta.url).href;
    for (const tag of ['config', 'child']) {
      writeFileSync(path.join(dir, tag + '-signal.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync('${tag}-touched', '');
export const unused = true;
`);
    }
    writeFileSync(path.join(dir, 'child.ts'), `
import { unused } from './child-signal.mjs';
export { name } from './name.mjs';
`);
    writeFileSync(path.join(dir, 'e2e.config.ts'), `
import { existsSync } from 'node:fs';
import { unused } from './config-signal.mjs';
import { name } from './child.ts#user';
import { createFakeEngine, FAKE_APP } from ${JSON.stringify(engine)};
const signals = ['config', 'child'].filter(tag => existsSync(tag + '-touched'));
export default { targets: [{ name: [name, ...signals].join('-'), platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }] };
`);
    writeFileSync(path.join(dir, 'probe.mjs'), `
import { openHost } from ${JSON.stringify(runner)};
import { registerHooks } from 'node:module';
import { rmSync, writeFileSync } from 'node:fs';
const order = ${JSON.stringify(order)};
function instrument() {
  registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url.startsWith('file:') && /\\/(?:e2e\\.config|child)\\.ts$/.test(new URL(result.url).pathname)) {
      const added = ${JSON.stringify(added)};
      if (added === 'fragment') return { ...result, url: result.url + '#instrumented' };
      // Appended after everything, a fragment the import carries included.
      if (added === 'query') return { ...result, url: result.url + (result.url.includes('?') ? '&' : '?') + 'instrumented=1' };
      // Written into the query, before the fragment, with the query written out again.
      const url = new URL(result.url);
      url.searchParams.set('instrumented', '1');
      return { ...result, url: url.href };
    }
    return result;
  } });
}
async function target(name, verbatimModuleSyntax) {
  writeFileSync('name.mjs', 'export const name = ' + JSON.stringify(name));
  writeFileSync('tsconfig.json', JSON.stringify({ compilerOptions: { verbatimModuleSyntax } }));
  for (const tag of ['config', 'child']) rmSync(tag + '-touched', { force: true });
  const host = await openHost({ cwd: process.cwd(), env: {} });
  try { return host.target; } finally { await host.close(); }
}
if (order === 'before') instrument();
const first = await target('one', false);
if (order === 'after') instrument();
console.log(JSON.stringify([first, await target('two', true), await target('three', false)]));
`);
    const actual = execFileSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    expect(JSON.parse(actual)).toEqual(['one', 'two-config-child', 'three']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);

const legacyEntries = ['dist/config/load.js', 'src/config/load.ts'];
it.each(legacyEntries)('keeps the loads an older copy starts from %s fresh while leaving unwritten user queries literal', (entry) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-host-legacy-loader-'));
  try {
    // Match the old config/load entry without pinning a published package.
    const importConfig = `
import { pathToFileURL } from 'node:url';
export function load(file, query = '?e2e=module-1&e2e-graph=module-1') {
  return import(pathToFileURL(file).href + query);
}
`;
    for (const [folder, name] of [['legacy', 'e2e'], ['user', 'example']] as const) {
      const root = path.join(dir, folder);
      mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, type: 'module' }));
      writeFileSync(path.join(root, entry), importConfig);
    }
    writeFileSync(path.join(dir, 'legacy', 'helper.mjs'), importConfig);
    const engine = new URL('../helpers/fake-engine.ts', import.meta.url).href;
    writeFileSync(path.join(dir, 'name.mjs'), "export const name = 'one';");
    writeFileSync(path.join(dir, 'e2e.config.mjs'), `
import { name } from './name.mjs';
import { createFakeEngine, FAKE_APP } from ${JSON.stringify(engine)};
export default { targets: [{ name, platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }] };
`);
    writeFileSync(path.join(dir, 'child.mjs'), 'export const search = new URL(import.meta.url).search;');
    // What an older copy's collection loads: a test file that imports a module registering tests.
    writeFileSync(path.join(dir, 'registrar.mjs'), `
import { fileURLToPath } from 'node:url';
globalThis[Symbol.for('e2e.registrar-module.v1')](fileURLToPath(import.meta.url));
globalThis.registrations = (globalThis.registrations ?? 0) + 1;
`);
    // A test file reaches it directly, or through a helper that registers nothing itself.
    for (const [suite, imported] of [['direct', 'registrar'], ['suite-a', 'middle-a'], ['suite-b', 'middle-b'], ['suite-late', 'late']]) {
      writeFileSync(path.join(dir, suite + '.mjs'), `import './${imported}.mjs';\nexport const registrations = globalThis.registrations;\n`);
    }
    for (const helper of ['middle-a', 'middle-b']) writeFileSync(path.join(dir, helper + '.mjs'), "import './registrar.mjs';\n");
    writeFileSync(path.join(dir, 'late.mjs'), "export const get = () => import('./registrar.mjs');\n");
    for (const name of ['helper', 'user', 'extra', 'repeat']) {
      writeFileSync(path.join(dir, name + '.mjs'), `
import { search as child } from './child.mjs';
export const searches = [new URL(import.meta.url).search, child];
`);
    }
    const runner = new URL('../../dist/runner.js', import.meta.url).href;
    writeFileSync(path.join(dir, 'probe.mjs'), `
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let instrumentEarlier = false;
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (instrumentEarlier && result.url.startsWith('file:') && new URL(result.url).pathname.endsWith('/e2e.config.mjs') && result.url.includes('?')) {
    const rewritten = new URL(result.url);
    rewritten.searchParams.append('earlier', '1');
    rewritten.search = rewritten.search.replaceAll('+', '%20');
    return { ...result, url: rewritten.href };
  }
  return result;
} });

const { openHost } = await import(${JSON.stringify(runner)});
let instrument = false;
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (instrument && result.url.startsWith('file:')) {
    const pathname = new URL(result.url).pathname;
    if (pathname.endsWith('/e2e.config.mjs') || pathname.endsWith(${JSON.stringify('/legacy/' + entry)})) {
      return { ...result, url: result.url + '#instrumented' };
    }
  }
  return result;
} });
const { load: legacy } = await import('./legacy/${entry}');
const { load: helper } = await import('./legacy/helper.mjs');
const { load: user } = await import('./user/${entry}');

const host = await openHost({ cwd: process.cwd(), env: {} });
const first = host.target;
await host.close();
await import('./name.mjs');
writeFileSync('name.mjs', "export const name = 'two';");
const updated = (await legacy(path.resolve('e2e.config.mjs'))).default.targets[0].name;
instrument = true;
const { load: decoratedLegacy } = await import('./legacy/${entry}?decorated=1');
writeFileSync('name.mjs', "export const name = 'three';");
const tagged = (await decoratedLegacy(path.resolve('e2e.config.mjs'), '?e2e=module-2&e2e-graph=module-2')).default.targets[0].name;
instrumentEarlier = true;
writeFileSync('name.mjs', "export const name = 'four';");
const reopened = (await decoratedLegacy(path.resolve('e2e.config.mjs'), '?e2e=module-3&e2e-graph=one+run')).default.targets[0].name;
instrumentEarlier = false;
// The same shape of query from another file of the package, from another package, and with a parameter beside it.
const fromHelper = (await helper(path.resolve('helper.mjs'), '?e2e=module-7&e2e-graph=module-7')).searches;
const fromUser = (await user(path.resolve('user.mjs'), '?e2e=module-7&e2e-graph=module-7')).searches;
const fromExtra = (await legacy(path.resolve('extra.mjs'), '?e2e=module-8&e2e-graph=module-8&user=yes')).searches;
// A query that repeats parameters the older copy did write is read as that copy's, as released versions read any.
const repeated = (await user(path.resolve('repeat.mjs'), '?e2e=module-1&e2e-graph=module-1')).searches;
// A named graph, as a watch run or an MCP session starts: its modules are shared under the name.
const named = [];
for (const [query, name] of [['?e2e=module-4&e2e-graph=run-1', 'five'], ['?e2e=module-5&e2e-graph=run-1', 'six'], ['?e2e=module-6&e2e-graph=run%2F2', 'seven'], ['?e2e=module-9&e2e-graph=', 'eight'], ['?e2e=module-10&e2e-graph=', 'nine']]) {
  writeFileSync('name.mjs', 'export const name = ' + JSON.stringify(name));
  named.push((await legacy(path.resolve('e2e.config.mjs'), query)).default.targets[0].name);
}
// A collection holds e2e.activeCollector.v1 while its module imports: each load evaluates the
// registrar again through a helper, and an import from a helper after collection ends does not.
const collectorSymbol = Symbol.for('e2e.activeCollector.v1');
async function collect(load, suite, query) {
  globalThis[collectorSymbol] = {};
  try {
    return (await load(path.resolve(suite + '.mjs'), query)).registrations;
  } finally {
    delete globalThis[collectorSymbol];
  }
}
const collected = [];
for (const [load, suite, query] of [
  [legacy, 'suite-a', '?e2e=collect-1'],
  [legacy, 'suite-b', '?e2e=collect-2'],
  [legacy, 'suite-a', '?e2e=collect-3'],
  [legacy, 'direct', '?e2e=collect-4'],
  [legacy, 'suite-late', '?e2e=collect-5'],
  [user, 'suite-a', '?e2e=collect-6'],
  [helper, 'direct', '?e2e=collect-7'],
]) {
  collected.push(await collect(load, suite, query));
}
const lateHelper = await import(pathToFileURL(path.resolve('late.mjs')).href);
await lateHelper.get();
const afterCollection = globalThis.registrations;
console.log(JSON.stringify({ first, updated, tagged, reopened, fromHelper, fromUser, fromExtra, repeated, named, collected, afterCollection }));
`);
    const actual = execFileSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    const query = '?e2e=module-1&e2e-graph=module-1';
    expect(JSON.parse(actual)).toEqual({
      first: 'one',
      updated: 'two',
      tagged: 'three',
      reopened: 'four',
      fromHelper: ['?e2e=module-7&e2e-graph=module-7', ''],
      fromUser: ['?e2e=module-7&e2e-graph=module-7', ''],
      fromExtra: ['?e2e=module-8&e2e-graph=module-8&user=yes', ''],
      repeated: [query, '?e2e-graph=module-1'],
      named: ['five', 'five', 'seven', 'eight', 'eight'],
      collected: [1, 2, 3, 4, 4, 4, 4],
      afterCollection: 4,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);

it('keeps a module in its load and its graph when a resolver registered after the loader changes its URL or answers for it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-loader-later-resolver-'));
  try {
    mkdirSync(path.join(dir, 'real'));
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
    writeFileSync(path.join(dir, 'real', 'entry.mjs'), "export const importChild = (specifier = './child.mjs') => import(specifier);");
    writeFileSync(path.join(dir, 'real', 'helper.mjs'), "export const importChild = () => import('./child.mjs');");
    writeFileSync(path.join(dir, 'real', 'child.mjs'), 'export const url = import.meta.url;');
    const hooks = new URL('../../dist/config/esm-hooks.js', import.meta.url).href;
    writeFileSync(path.join(dir, 'probe.mjs'), `
import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { importFreshModule, registerLoader, runInLoad } from ${JSON.stringify(hooks)};

registerLoader();
registerHooks({ resolve(specifier, context, next) {
  // Answers for one entry itself, so the loader never resolves it.
  if (specifier.includes('/entry.mjs?') && specifier.includes('bypassed')) return { url: specifier, shortCircuit: true };
  const result = next(specifier, context);
  return result.url.includes('/entry.mjs?') && result.url.includes('tagged') ? { ...result, url: result.url + '#late' } : result;
} });
const search = async (load) => new URL((await load).url).search;

// The first load evaluates the child as written; registering it makes later loads evaluate it again.
const first = await importFreshModule(path.resolve('real/entry.mjs'), 'first', 'shared');
await runInLoad('first', () => first.importChild());
globalThis[Symbol.for('e2e.registrar-module.v1')](realpathSync('real/child.mjs'));

// An entry reached through a symlink, whose URL a later resolver appended a fragment to.
const tagged = await importFreshModule(path.resolve('alias/entry.mjs'), 'tagged', 'shared');
const outsideLoad = await search(tagged.importChild());
const inOtherLoad = await search(runInLoad('other', () => tagged.importChild('././child.mjs')));
const sharedHelper = await tagged.importChild('./helper.mjs');
const fromSharedHelper = await search(sharedHelper.importChild());

// An entry another resolver answered for.
const bypassed = await importFreshModule(realpathSync('real/entry.mjs'), 'bypassed', 'apart');
const afterBypass = await search(bypassed.importChild());
console.log(JSON.stringify({ outsideLoad, inOtherLoad, fromSharedHelper, afterBypass }));
`);
    const actual = execFileSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    expect(JSON.parse(actual)).toEqual({
      // The module's own load, wherever its import runs; a helper with no load key keeps none outside runInLoad.
      outsideLoad: '?e2e-graph=shared&e2e=tagged',
      inOtherLoad: '?e2e-graph=shared&e2e=tagged',
      fromSharedHelper: '?e2e-graph=shared',
      afterBypass: '?e2e-graph=apart&e2e=bypassed',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);
