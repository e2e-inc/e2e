import { readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isRecord } from '@e2e-dev/core/lib/config/command';
import { errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { outputLayout } from '@e2e-dev/core/lib/run/output';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Report1Document, ReportShard } from './build.ts';

export interface ShardInput {
  readonly directory: string;
  readonly document: Report1Document;
  readonly shard: ReportShard;
  readonly repeatEach?: number;
}

let validator: ValidateFunction<Report1Document> | undefined;

function reportValidator(): ValidateFunction<Report1Document> {
  if (validator !== undefined) return validator;
  const ajv = new Ajv2020({ strict: false });
  addFormats.default(ajv);
  const schemaPath = new URL('../../schema/report-v1.schema.json', import.meta.url);
  const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error('the installed report-1 schema is invalid');
  }
  validator = ajv.compile<Report1Document>(schema);
  return validator;
}

async function readReport(file: string, historyForRunId?: string): Promise<Report1Document | undefined> {
  try {
    const contents: unknown = JSON.parse(await readFile(file, 'utf8'));
    const candidateRun = isRecord(contents) && isRecord(contents['run']) ? contents['run'] : undefined;
    const id = candidateRun?.['id'];
    if (historyForRunId !== undefined && typeof id === 'string' && id !== historyForRunId) return undefined;
    const validate = reportValidator();
    if (!validate(contents)) {
      const issue = validate.errors?.[0];
      throw new Error(`expected a report-1 document (invalid ${issue?.instancePath || 'envelope'}: ${issue?.keyword ?? 'schema'})`);
    }
    return contents;
  } catch (cause) {
    if (historyForRunId !== undefined && (cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A JSON parse error can echo bytes from a hand-edited input.
    const detail = cause instanceof SyntaxError ? 'invalid JSON' : errorMessage(cause);
    throw new Error(`could not read ${file}: ${detail}`, { cause });
  }
}

export async function readShard(directory: string): Promise<ShardInput> {
  const real = await realpath(directory);
  const layout = outputLayout(real);
  const raw = (await readReport(layout.report))!;
  const chosen = await readReport(layout.withReruns, raw.run.id) ?? raw;
  if (chosen === raw && raw.run.carried !== undefined) {
    throw new Error(`${layout.report} has unresolved results and requires its matching report-with-reruns.json`);
  }
  const shard = chosen.run.shard;
  if (chosen.run.finishedAt === undefined) {
    throw new Error(`${layout.report} is unfinished; supply output from a finished shard run`);
  }
  if (chosen.run.explore !== undefined || shard === undefined || shard.index > shard.total) {
    throw new Error(`${layout.report} has no valid shard identity; supply output from e2e run --shard`);
  }
  // Older rows can omit these fields. The runner treats missing selection as selected.
  for (const row of chosen.run.results) {
    row.agent ??= 'default';
    row.repeat ??= 0;
    row.tags ??= [];
    row.selected ??= row.skip?.otherShard !== true;
  }
  for (const group of chosen.run.serialGroups) {
    group.agent ??= 'default';
    group.repeat ??= 0;
  }
  // A folded rerun can collapse repeat rows, and an empty shard has no
  // runnable row from which to read its repeat count.
  const repeatEach = chosen === raw ? observedRepeatCount(raw.run) : undefined;
  return { directory: real, document: chosen, shard, ...(repeatEach === undefined ? {} : { repeatEach }) };
}

function observedRepeatCount(run: Report1Document['run']): number | undefined {
  const runnable = run.results.filter((row) => row.kind === 'test' && row.selected);
  const repeatEach = runnable.reduce((max, row) => Math.max(max, row.repeat + 1), 1);
  if (repeatEach > 1 || runnable.some((row) => row.attempts.length > 0) || run.serialGroups.some((group) => group.attempts.length > 0)) {
    return repeatEach;
  }
  return undefined;
}
