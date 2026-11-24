import { copyFile, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { resultSegment } from '@e2e-dev/core/lib/run/artifacts';
import { outputLayout } from '@e2e-dev/core/lib/run/output';
import type { Report1Document, ReportAttempt, ReportSerialAttempt } from './build.ts';
import type { ShardInput } from './merge-input.ts';

export function inside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

/**
 * Copy only artifacts named by retained attempts. Prefix the paths, so two
 * setup runs can keep the same relative filename and their own bytes.
 */
export async function copyMergedArtifacts(report: Report1Document, inputs: readonly ShardInput[], destination: string): Promise<Set<string>> {
  const roots = new Map(inputs.map(({ directory, shard }) => [shard.index, outputLayout(directory).results]));
  const copied = new Set<string>();
  const traced = new Set<string>();

  async function copy(attempt: ReportAttempt | ReportSerialAttempt): Promise<void> {
    const root = roots.get(attempt.shard!)!;
    const artifacts: ReportAttempt['artifacts'][number][] = [];
    for (const artifact of attempt.artifacts) {
      const relative = artifact.path;
      if (relative === undefined) {
        artifacts.push(artifact);
        continue;
      }
      if (/^[A-Za-z]:/u.test(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw new Error(`invalid local artifact path in shard ${attempt.shard}`);
      }
      const merged = `shard-${attempt.shard}/${relative}`;
      if (!copied.has(merged)) {
        const from = await realpath(path.join(root, relative));
        if (!inside(root, from) || !(await stat(from)).isFile()) {
          throw new Error(`artifact in shard ${attempt.shard} must be a file inside its results directory`);
        }
        const to = path.join(destination, merged);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(from, to);
        copied.add(merged);
      }
      artifacts.push({ ...artifact, path: merged });
    }
    attempt.artifacts = artifacts;
  }

  const groups = new Map(report.run.serialGroups.map((group) => [group.id, group]));
  for (const group of groups.values()) for (const attempt of group.attempts) await copy(attempt);
  for (const result of report.run.results) {
    for (const attempt of result.attempts) await copy(attempt);
    const attempts = result.serialGroupId === undefined ? result.attempts : groups.get(result.serialGroupId)?.attempts ?? [];
    for (const shard of new Set(attempts.map((attempt) => attempt.shard!))) {
      if (await exists(path.join(roots.get(shard)!, resultSegment(result), 'trace.md'))) {
        traced.add(result.id);
        break;
      }
    }
  }
  return traced;
}
