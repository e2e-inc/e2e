/**
 * `toHaveScreenshot` encodes on the addon's pool before it writes a stored
 * screenshot or attaches one, so an attempt cancelled during that encode
 * must not leave the file behind: the step already ended as cancelled.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveExpression, type SemanticNode } from '@e2e-dev/core/lib/engine/index';
import { encodePng } from '@e2e-dev/core/lib/internal/image';
import { WrittenScreenshots } from '@e2e-dev/core/lib/run/screenshots';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { encodeRgbaPng } from '../helpers/rgba-png.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

vi.mock('@e2e-dev/core/lib/internal/image', { spy: true });

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
    const encode = vi.mocked(encodePng);
    encode.mockClear();
    encode.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      return png;
    });
    const project = path.join(dir, 'project');
    const artifacts = path.join(dir, 'artifacts');
    const { screen } = screenOver({
      locate: (expression) => resolveExpression(expression, [ROOT]),
      observe: () => {
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
    expect(encode).toHaveBeenCalledOnce();
    expect([dir].flatMap(filesUnder)).toEqual([]);
  });
});
