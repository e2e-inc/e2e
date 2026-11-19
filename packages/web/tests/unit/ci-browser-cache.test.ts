/**
 * The CI files `e2e init --ci` writes cache the engine's browsers, so each
 * must name the directory, or set the variable, this installer reads.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { browsersPath } from '../../src/install/provision.ts';

/** A CI template of the `e2e` package, as `e2e init` reads it. */
function template(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../e2e/templates/ci/${name}`, import.meta.url)), 'utf8');
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
});

it('the GitHub Actions workflow caches the directory browsers install into on a Linux runner', () => {
  const installed = `~/${path.posix.relative(os.homedir(), browsersPath({}))}`;
  expect(installed).toBe('~/.cache/e2e/browsers');
  expect(template('github-actions.yml')).toContain(`        with:\n          path: ${installed}\n`);
});

it('the GitLab pipeline sets a variable the installer reads to the directory it caches', () => {
  const pipeline = template('gitlab-ci.yml');
  const [, variable, directory] = /^ {2}variables:\n(?: {4}#.*\n)* {4}(\w+): \$CI_PROJECT_DIR\/(\S+)\n/m.exec(pipeline) ?? [];
  expect(variable).toBeDefined();
  expect(browsersPath({ [variable!]: `/builds/project/${directory!}` })).toBe(`/builds/project/${directory!}`);
  expect(pipeline).toContain(`    paths:\n      - ${directory!}/\n`);
});
