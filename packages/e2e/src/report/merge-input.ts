import { readFile, realpath } from 'node:fs/promises';
import { errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { outputLayout } from '@e2e-dev/core/lib/run/output';
import { z } from 'zod';
import type { Report1Document, ReportShard } from './build.ts';

export interface ShardInput {
  readonly directory: string;
  readonly document: Report1Document;
  readonly shard: ReportShard;
}

// Validate the merge envelope and the nested collections the merge walks.
// Keep each report's original wire data for the finished-run reporters.
const positive = z.number().int().positive();
const timestamp = z.iso.datetime({ precision: 3 });
const artifact = z.object({ id: z.string(), path: z.string().optional() });
const step = z.object({ events: z.array(z.unknown()), artifacts: z.array(z.string()) });
const attempt = z.object({ artifacts: z.array(artifact), secondaryErrors: z.array(z.unknown()) });
const verdict = z.enum(['passed', 'flaky', 'failed', 'timed-out', 'interrupted', 'skipped']);
const pair = {
  id: z.string(),
  targetId: z.string(),
  agent: z.string(),
  repeat: z.number().int().nonnegative(),
  status: verdict,
};
const document = z.object({
  schemaVersion: z.literal('report-1'),
  run: z.object({
    id: z.uuidv7(),
    specVersion: z.literal('0.1'),
    runner: z.object({ name: z.literal('e2e'), version: z.string() }),
    project: z.object({ id: z.string(), configDigest: z.string() }),
    vcs: z.object({ commit: z.string() }).optional(),
    shard: z.object({ index: positive, total: positive }).optional(),
    status: z.enum(['passed', 'failed', 'error', 'interrupted', 'blocked']),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(130)]),
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: z.number().nonnegative().optional(),
    environment: z.object({ ci: z.boolean() }),
    limits: z.object({}),
    errors: z.array(z.object({ category: z.string(), code: z.string(), message: z.string() })),
    targets: z.array(z.object({ id: z.string(), platform: z.string() })),
    results: z.array(z.object({
      ...pair,
      id: z.string().regex(/^[a-f0-9]{64}$/u),
      kind: z.enum(['setup', 'test']),
      testId: z.string(),
      file: z.string(),
      titlePath: z.array(z.string()),
      tags: z.array(z.string()),
      declarationIndex: z.number(),
      selected: z.boolean(),
      serialGroupId: z.string().optional(),
      skip: z.object({ otherShard: z.literal(true).optional(), cause: z.string(), reason: z.string() }).optional(),
      attempts: z.array(attempt.extend({ steps: z.array(step) })),
    })),
    serialGroups: z.array(z.object({
      ...pair,
      agent: pair.agent.optional(),
      repeat: pair.repeat.optional(),
      attempts: z.array(attempt.extend({ members: z.array(z.object({
        testId: z.string(),
        steps: z.array(step),
        secondaryErrors: z.array(z.unknown()),
      })) })),
    })),
    usage: z.object({
      discoveredResults: z.number().nonnegative(),
      maxAgentContextBytes: z.number().nonnegative(),
      maxLedgerBytes: z.number().nonnegative(),
      maxObservationBytes: z.number().nonnegative(),
      artifactBytes: z.number().nonnegative(),
      downloads: z.number().nonnegative(),
      events: z.number().nonnegative(),
      modelTokens: z.number().nonnegative(),
      modelCachedTokens: z.number().nonnegative().optional(),
      maxModelCallsInStep: z.number().nonnegative(),
      maxActionStepsInStep: z.number().nonnegative(),
      estimatedCostUsd: z.number().nonnegative().optional(),
    }),
  }),
});

async function readReport(file: string, optional = false): Promise<Report1Document | undefined> {
  try {
    const contents: unknown = JSON.parse(await readFile(file, 'utf8'));
    const checked = document.safeParse(contents);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new Error(`expected a report-1 document (invalid ${issue?.path.join('.') || 'envelope'})`);
    }
    return contents as Report1Document;
  } catch (cause) {
    if (optional && (cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A JSON parse error can echo bytes from a hand-edited input.
    const detail = cause instanceof SyntaxError ? 'invalid JSON' : errorMessage(cause);
    throw new Error(`could not read ${file}: ${detail}`, { cause });
  }
}

export async function readShard(directory: string): Promise<ShardInput> {
  const real = await realpath(directory);
  const layout = outputLayout(real);
  const raw = (await readReport(layout.report))!;
  const history = await readReport(layout.withReruns, true);
  const chosen = history?.run.id === raw.run.id ? history : raw;
  const shard = chosen.run.shard;
  if (chosen.run.explore !== undefined || shard === undefined || shard.index > shard.total) {
    throw new Error(`${layout.report} has no valid shard identity; supply output from e2e run --shard`);
  }
  return { directory: real, document: chosen, shard };
}
