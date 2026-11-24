import { readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { outputLayout } from '@e2e-dev/core/lib/run/output';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Report1Document, ReportShard } from './build.ts';

export interface ShardInput {
  readonly directory: string;
  readonly document: Report1Document;
  readonly shard: ReportShard;
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

async function readReport(file: string, optional = false): Promise<Report1Document | undefined> {
  try {
    const contents: unknown = JSON.parse(await readFile(file, 'utf8'));
    const validate = reportValidator();
    if (!validate(contents)) {
      const issue = validate.errors?.[0];
      throw new Error(`expected a report-1 document (invalid ${issue?.instancePath || 'envelope'}: ${issue?.keyword ?? 'schema'})`);
    }
    return contents;
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
  return { directory: real, document: chosen, shard };
}
