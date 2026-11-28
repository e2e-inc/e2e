import { describe, expect, it } from 'vitest';
import { detectFramework, productionScripts, type FrameworkManifest } from '../../src/cli/init/frameworks.ts';

/** Detects the framework of a project with this package.json and, by default, no other files. */
function detectIn(manifest: FrameworkManifest, readFile: (name: string) => string | undefined = () => undefined) {
  return detectFramework({ manifest, readFile });
}

/** The scripts `create-next-app` writes. */
const NEXT_SCRIPTS = { dev: 'next dev', build: 'next build', start: 'next start' };

/** The scripts `create vite` writes for its React, Vue, Svelte, Solid, Preact, and Lit templates. */
const VITE_SCRIPTS = { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' };

describe('detectFramework', () => {
  it('finds Next.js in dependencies or devDependencies, and nothing without it', () => {
    const app = {
      kind: 'app',
      framework: 'Next.js',
      docs: '/frameworks/nextjs',
      url: 'http://localhost:3000',
      dev: 'dev',
      production: { build: 'build', start: 'start' },
    };
    expect(detectIn({ dependencies: { next: '16.4.6' }, scripts: NEXT_SCRIPTS })).toEqual(app);
    expect(detectIn({ devDependencies: { next: '^16' }, scripts: NEXT_SCRIPTS })).toEqual(app);
    expect(detectIn({ dependencies: { react: '^19' }, scripts: NEXT_SCRIPTS })).toBeUndefined();
    expect(detectIn({})).toBeUndefined();
  });

  it.each([
    ['next dev --port 3100', 3100],
    ['next dev --port=3100', 3100],
    ['next dev -p 3100', 3100],
    ['next dev -p3100', 3100],
    ['next dev --turbopack -p 4000', 4000],
    ['PORT=4100 next dev', 4100],
    ['PORT=4100 next dev --port 4200', 4200],
    ['concurrently "next dev -p 4300" "tsc --watch"', 4300],
    ['next dev -p 4400 && echo ready', 4400],
    ['node scripts/preflight.js && next dev --port 4500', 4500],
    ['next dev', 3000],
    ['turbo run dev', 3000],
  ])('reads the port of %j as %d', (dev, port) => {
    const found = detectIn({ dependencies: { next: '*' }, scripts: { dev } });
    expect(found).toMatchObject({ kind: 'app', url: `http://localhost:${port}` });
  });

  it.each([
    'next dev -p $PORT',
    'next dev --port 0',
    'next dev --port 70000',
    'next dev --port',
    'node scripts/preflight.js -p 8080 && next dev',
    'export PORT=4000 && next dev',
  ])(
    'cannot start an app whose dev script is %j, with no port it can read',
    (dev) => {
      expect(detectIn({ dependencies: { next: '*' }, scripts: { dev } })).toEqual({
        kind: 'unsupported',
        framework: 'Next.js',
        docs: '/frameworks/nextjs',
        reason: 'init cannot read a fixed port from the dev script',
      });
    },
  );

  it('cannot start an app with no dev script', () => {
    expect(detectIn({ dependencies: { next: '*' }, scripts: { build: 'next build' } })).toMatchObject({
      kind: 'unsupported',
      reason: 'package.json has no dev script',
    });
  });

  it('tests the production build only when build and start scripts serve it on the dev port', () => {
    const production = (scripts: Record<string, string>) =>
      (detectIn({ dependencies: { next: '*' }, scripts }) as { production?: unknown }).production;
    expect(production({ dev: 'next dev -p 3100', build: 'next build', start: 'next start -p 3100' })).toEqual({ build: 'build', start: 'start' });
    expect(production({ dev: 'next dev -p 3100', build: 'next build', start: 'next start' })).toBeUndefined();
    expect(production({ dev: 'next dev', build: 'next build', start: 'next start -p $PORT' })).toBeUndefined();
    expect(production({ dev: 'next dev', start: 'next start' })).toBeUndefined();
    expect(production({ dev: 'next dev', build: 'next build' })).toBeUndefined();
  });

  it('finds the production scripts of an existing app on any port', () => {
    expect(productionScripts({ dependencies: { next: '*' }, scripts: { dev: 'next dev -p 3100', build: 'next build', start: 'next start' } }))
      .toEqual({ build: 'build', start: 'start' });
    expect(productionScripts({ dependencies: { next: '*' }, scripts: { build: 'next build', start: 'next start' } }))
      .toEqual({ build: 'build', start: 'start' });
    expect(productionScripts({ dependencies: { next: '*' }, scripts: { start: 'next start' } })).toBeUndefined();
    expect(productionScripts({ scripts: NEXT_SCRIPTS })).toBeUndefined();
  });
});

describe('detectFramework on a Vite app', () => {
  const vite = (scripts: Record<string, string>, readFile?: (name: string) => string | undefined) =>
    detectIn({ devDependencies: { vite: '^8.3.6' }, scripts }, readFile);

  it('starts the dev server on 5173 and never a production build, which vite preview serves elsewhere', () => {
    expect(vite(VITE_SCRIPTS)).toEqual({ kind: 'app', framework: 'Vite', docs: '/reference/cli#vite-apps', url: 'http://localhost:5173', dev: 'dev' });
    expect(vite({ ...VITE_SCRIPTS, start: 'vite preview --port 5173' })).not.toHaveProperty('production');
    expect(productionScripts({ devDependencies: { vite: '*' }, scripts: { ...VITE_SCRIPTS, start: 'vite preview' } })).toBeUndefined();
  });

  it('prefers Next.js in a project that lists both', () => {
    expect(detectIn({ dependencies: { next: '*' }, devDependencies: { vite: '*' }, scripts: NEXT_SCRIPTS })).toMatchObject({ framework: 'Next.js' });
  });

  it.each([
    ['vite --port 4100', 4100],
    ['vite --port=4100', 4100],
    ['vite dev --port 4200', 4200],
    ['vite serve --host', 5173],
    ['npx vite --strictPort', 5173],
    // Vite reads no PORT variable.
    ['PORT=4300 vite', 5173],
    ['vite --port "4300"', 4300],
    ['concurrently "vite --port 4400" "tsc -b --watch"', 4400],
    // Vite reads only its own --port: another command's port never reaches it.
    ['node scripts/env.js --port 4000 && vite', 5173],
    ['concurrently "vite" "json-server --port 3001 db.json"', 5173],
    ['concurrently -n web,api "vite --port 4500" "json-server -p 3001"', 4500],
    ['cross-env NODE_ENV=development vite --port 4600', 4600],
    ['pnpm exec vite', 5173],
    ['concurrently -k "vite" "tsc -w"', 5173],
    ['bash -c "vite --port 4300"', 4300],
    ['concurrently --kill-others "vite" "tsc -w"', 5173],
    ['concurrently -r "vite --port 4100" "tsc -w"', 4100],
    ['vite --mode "development" --port 4200', 4200],
    // Vite's CLI ignores what follows `--`.
    ['vite -- --port 4100', 5173],
    // A boolean option takes `true` or `false` as its value, which is not a root.
    ['vite --clearScreen false', 5173],
    ['vite --strictPort true --port 4100', 4100],
    ['vite dev --force false --cors true', 5173],
  ])('reads the port of %j as %d', (dev, port) => {
    expect(vite({ dev })).toMatchObject({ kind: 'app', url: `http://localhost:${port}` });
  });

  it.each([
    ['tsc -b --watch', 'the dev script does not start the Vite dev server'],
    // Only a launcher's quoted arguments are commands.
    ['echo "vite"', 'the dev script does not start the Vite dev server'],
    ['vite build --watch', 'the dev script does not start the Vite dev server'],
    ['react-router dev', 'the dev script does not start the Vite dev server'],
    ['storybook dev -p 6006', 'the dev script does not start the Vite dev server'],
    ['vite --port $PORT', 'init cannot read a fixed port from the dev script'],
  ])('cannot start an app whose dev script is %j', (dev, reason) => {
    expect(vite({ dev })).toEqual({ kind: 'unsupported', framework: 'Vite', docs: '/reference/cli#vite-apps', reason });
  });

  it.each([
    'export default defineConfig({ server: { port: 3000 } });',
    'const port = 3000;\nexport default defineConfig({ server: { port } });',
    'export default defineConfig({ server: { port: Number(process.env.APP_PORT) } });',
    'export default defineConfig({ server: { port: 5173 }, preview: { port: 4173 } });',
    // A `//` in a string is not a comment that hides the port after it.
    "export default defineConfig({ base: '//cdn.example.com/', server: { port: 3000 } });",
  ])('cannot start an app whose Vite config names a port other than the dev port, or one init cannot read: %j', (text) => {
    expect(vite(VITE_SCRIPTS, (name) => (name === 'vite.config.ts' ? text : undefined))).toMatchObject({
      kind: 'unsupported',
      reason: 'vite.config.ts sets a port other than 5173',
    });
  });

  it.each([
    ['export default defineConfig({ plugins: [react()] });', 'vite', 5173],
    ['export default defineConfig({ server: { port: 5173, strictPort: true } });', 'vite', 5173],
    ['export default defineConfig({ server: { port: 4100 } });', 'vite --port 4100', 4100],
    // `--port` wins over the config's port.
    ['export default defineConfig({ server: { port: 3000 } });', 'vite --port 4100', 4100],
    // Based on examples/with-vite/vite.config.ts: a comment that says "port" is not a port.
    ["export default defineConfig({\n  plugins: [react()],\n  // A fixed port, so e2e.config.ts knows where the app is.\n  server: { port: 5173, strictPort: true }, /* not the preview port */\n  base: 'http://cdn.example.com//assets',\n});", 'vite', 5173],
  ])('starts an app whose Vite config %j keeps the port of %j on %d', (text, dev, port) => {
    expect(vite({ dev }, (name) => (name === 'vite.config.mjs' ? text : undefined))).toMatchObject({ kind: 'app', url: `http://localhost:${port}` });
  });

  it.each([
    ['vite --config vite.dev.ts', 'the dev script names its own Vite config'],
    ['concurrently "vite --config vite.dev.ts" "tsc -w"', 'the dev script names its own Vite config'],
    ['vite web', 'the dev script serves another directory'],
    ['vite serve web --port 4100', 'the dev script serves another directory'],
    ['cd web && vite', 'the dev script serves another directory'],
    ['vite "web"', 'the dev script serves another directory'],
    ['vite false', 'the dev script serves another directory'],
    ['vite --force web', 'the dev script serves another directory'],
    ['vite -c vite.dev.ts', 'the dev script names its own Vite config'],
    ['vite dev --config=vite.dev.ts', 'the dev script names its own Vite config'],
  ])('cannot read the config of %j', (dev, reason) => {
    expect(vite({ dev })).toMatchObject({ kind: 'unsupported', reason });
  });

  it('reads options with values, and quoted commands beside vite, as no root', () => {
    expect(vite({ dev: 'vite --host 0.0.0.0 --mode staging --port 4100' })).toMatchObject({ kind: 'app', url: 'http://localhost:4100' });
    expect(vite({ dev: `concurrently 'vite' 'tsc -b --watch'` })).toMatchObject({ kind: 'app', url: 'http://localhost:5173' });
    expect(vite({ dev: 'concurrently "vite" "tailwindcss -c tw.js -w"' })).toMatchObject({ kind: 'app', url: 'http://localhost:5173' });
  });

  it.each([
    [{ devDependencies: { vite: '*', 'laravel-vite-plugin': '*' } }, undefined, 'laravel-vite-plugin'],
    [{ devDependencies: { vite: '*', 'vite-plugin-symfony': '*' } }, undefined, 'vite-plugin-symfony'],
    [{ devDependencies: { vite: '*' } }, 'artisan', 'artisan'],
    [{ devDependencies: { vite: '*' } }, 'manage.py', 'manage.py'],
  ])('cannot start the app of a backend whose assets Vite serves (%#)', (dependencies, file, marker) => {
    const found = detectIn({ ...dependencies, scripts: { dev: 'vite' } }, (name) => (name === file ? '' : undefined));
    expect(found).toEqual({
      kind: 'unsupported',
      framework: 'Vite',
      docs: '/reference/cli#vite-apps',
      reason: `${marker} marks a backend that serves the app, and the Vite dev server serves its assets`,
    });
  });

  it('cannot start an app with no dev script', () => {
    expect(vite({ build: 'vite build' })).toMatchObject({ kind: 'unsupported', reason: 'package.json has no dev script' });
  });

  it.each([
    [{ devDependencies: { vite: '*', '@vitejs/plugin-basic-ssl': '*' } }, undefined, '@vitejs/plugin-basic-ssl'],
    [{ devDependencies: { vite: '*', 'vite-plugin-mkcert': '*' } }, undefined, 'vite-plugin-mkcert'],
    [{ devDependencies: { vite: '*' } }, 'export default defineConfig({ server: { https: { key, cert } } });', 'vite.config.ts'],
    [{ devDependencies: { vite: '*' } }, 'const https = { key, cert };\nexport default defineConfig({ server: { https } });', 'vite.config.ts'],
  ])('cannot start an app whose dev server serves HTTPS (%#)', (dependencies, config, source) => {
    const found = detectIn({ ...dependencies, scripts: { dev: 'vite' } }, (name) => (name === 'vite.config.ts' ? config : undefined));
    expect(found).toMatchObject({ kind: 'unsupported', reason: `${source} serves the Vite dev server over HTTPS` });
  });

  it.each([
    "export default defineConfig({ base: 'https://cdn.example.com/' });",
    'export default defineConfig({ server: { https: false } });',
  ])('reads %j as no HTTPS dev server', (config) => {
    expect(vite(VITE_SCRIPTS, (name) => (name === 'vite.config.ts' ? config : undefined))).toMatchObject({ kind: 'app' });
  });
});
