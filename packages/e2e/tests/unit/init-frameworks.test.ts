import { describe, expect, it } from 'vitest';
import { detectFramework } from '../../src/cli/init/frameworks.ts';

/** The scripts `create-next-app` writes. */
const NEXT_SCRIPTS = { dev: 'next dev', build: 'next build', start: 'next start' };

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
    expect(detectFramework({ dependencies: { next: '16.4.6' }, scripts: NEXT_SCRIPTS })).toEqual(app);
    expect(detectFramework({ devDependencies: { next: '^16' }, scripts: NEXT_SCRIPTS })).toEqual(app);
    expect(detectFramework({ dependencies: { react: '^19' }, scripts: NEXT_SCRIPTS })).toBeUndefined();
    expect(detectFramework({})).toBeUndefined();
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
    ['next dev', 3000],
    ['turbo run dev', 3000],
  ])('reads the port of %j as %d', (dev, port) => {
    const found = detectFramework({ dependencies: { next: '*' }, scripts: { dev } });
    expect(found).toMatchObject({ kind: 'app', url: `http://localhost:${port}` });
  });

  it.each(['next dev -p $PORT', 'next dev --port 0', 'next dev --port 70000', 'next dev --port'])(
    'cannot start an app whose dev script is %j, with no fixed port',
    (dev) => {
      expect(detectFramework({ dependencies: { next: '*' }, scripts: { dev } })).toEqual({
        kind: 'unsupported',
        framework: 'Next.js',
        docs: '/frameworks/nextjs',
        reason: 'the port in the dev script is not a fixed number',
      });
    },
  );

  it('cannot start an app with no dev script', () => {
    expect(detectFramework({ dependencies: { next: '*' }, scripts: { build: 'next build' } })).toMatchObject({
      kind: 'unsupported',
      reason: 'package.json has no dev script',
    });
  });

  it('tests the production build only when build and start scripts serve it on the dev port', () => {
    const production = (scripts: Record<string, string>) =>
      (detectFramework({ dependencies: { next: '*' }, scripts }) as { production?: unknown }).production;
    expect(production({ dev: 'next dev -p 3100', build: 'next build', start: 'next start -p 3100' })).toEqual({ build: 'build', start: 'start' });
    expect(production({ dev: 'next dev -p 3100', build: 'next build', start: 'next start' })).toBeUndefined();
    expect(production({ dev: 'next dev', build: 'next build', start: 'next start -p $PORT' })).toBeUndefined();
    expect(production({ dev: 'next dev', start: 'next start' })).toBeUndefined();
    expect(production({ dev: 'next dev', build: 'next build' })).toBeUndefined();
  });
});
