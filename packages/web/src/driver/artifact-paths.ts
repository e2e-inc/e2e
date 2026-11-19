/** Where an attempt's artifacts go: one numbered, safely named path under the attempt directory for each. */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** The paths of one attempt's artifacts, numbered in the order they were reserved. */
export class ArtifactPaths {
  private counter = 0;

  /** `dir` is the attempt directory every path is under. */
  constructor(private readonly dir: string) {}

  /** Reserves one artifact path under the attempt directory: a counter keeps names unique, the label readable. */
  reserve(folder: string, label: string | undefined, extension: string): { relative: string; absolute: string } {
    this.counter += 1;
    const name = `${String(this.counter).padStart(3, '0')}${label === undefined ? '' : `-${sanitizeFilename(label)}`}${extension}`;
    const relative = path.posix.join(folder, name);
    const absolute = path.join(this.dir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    return { relative, absolute };
  }
}

/** Constrains a caller-supplied artifact label to a safe filename. */
function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'artifact';
}
