/**
 * `toHaveScreenshot` encodes on the addon's pool before it writes a stored
 * screenshot or attaches one, so an attempt cancelled during that encode
 * must not leave the file behind: the step already ended as cancelled.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveExpression, type SemanticNode } from '@e2e-dev/core/lib/engine/index';
import { WrittenScreenshots } from '@e2e-dev/core/lib/run/screenshots';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { encodeRgbaPng } from '../helpers/rgba-png.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const VIEWPORT = { width: 2560, height: 1440 };
const ROOT: SemanticNode = { ref: { id: 'root', revision: '' }, role: 'document' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'e2e-screenshot-cancel-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Every file under `root`, relative to it. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
}

describe('toHaveScreenshot cancelled while it encodes', () => {
  it.each([
    ['writes no stored screenshot', false],
    ['attaches nothing in CI', true],
  ])('%s', async (_title, ci) => {
    const png = encodeRgbaPng({ ...VIEWPORT, data: new Uint8Array(VIEWPORT.width * VIEWPORT.height * 4).fill(200) });
    const controller = new AbortController();
    let observes = 0;
    const project = path.join(dir, 'project');
    const artifacts = path.join(dir, 'artifacts');
    const { screen } = screenOver({
      locate: (expression) => resolveExpression(expression, [ROOT]),
      observe: () => {
        observes += 1;
        // The second capture matches the first, so the next native call is the encode: cancel during it.
        if (observes === 2) setTimeout(() => controller.abort(), 0);
        return snapshot([ROOT], { viewport: VIEWPORT, pixels: { data: png, mediaType: 'image/png', width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 } });
      },
      timeoutMs: 5_000,
      signal: controller.signal,
      screenshots: {
        projectRoot: project,
        directory: path.join(project, 'tests', 'shot.e2e.ts-snapshots'),
        suffix: '-fake',
        titlePath: ['shot'],
        update: false,
        ci,
        written: new WrittenScreenshots(path.join(dir, 'results')),
        artifacts: { dir: artifacts, register: (_kind, relativePath) => relativePath, link: (url) => url },
      },
    });
    await expect(expectFixture(screen).toHaveScreenshot('home')).rejects.toMatchObject({ code: 'CANCELLED' });
    // The encode itself is not stopped: wait for it, then look for what it would have written.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect([dir].flatMap(filesUnder)).toEqual([]);
  });
});
