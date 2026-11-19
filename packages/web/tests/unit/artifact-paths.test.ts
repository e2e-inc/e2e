/** `ArtifactPaths`: a label the engine does not choose becomes one plain, numbered file name under the attempt directory. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactPaths } from '../../src/driver/artifact-paths.ts';

const HOSTILE_NAMES = [
  '../../etc/passwd',
  '..',
  '/etc/cron.d/job',
  '..\\..\\Windows\\win.ini',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  'report.pdf:hidden-stream',
  'a\u0000b.txt',
  'CON',
  'nul.txt',
  'LPT1',
  `${'x'.repeat(300)}.zip`,
];

describe('ArtifactPaths.reserve', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-artifact-paths-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps no separator, drive colon, or control character of a label, bounds its length, and stays in its folder of the attempt directory', () => {
    const paths = new ArtifactPaths(dir);
    for (const name of HOSTILE_NAMES) {
      const { relative, absolute } = paths.reserve('downloads', name, '');
      expect(relative, name).toMatch(/^downloads\/\d{3}-[A-Za-z0-9._-]{1,64}$/);
      expect(absolute, name).toBe(path.join(dir, 'downloads', path.posix.basename(relative)));
    }
  });

  it('names an empty label, and numbers the paths in the order they were reserved', () => {
    const paths = new ArtifactPaths(dir);
    expect(paths.reserve('downloads', '', '').relative).toBe('downloads/001-artifact');
    expect(paths.reserve('screenshots', undefined, '.png').relative).toBe('screenshots/002.png');
  });
});
