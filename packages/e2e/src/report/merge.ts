import { combineExitCodes } from '@e2e-dev/core/lib/internal/errors';
import { uuidv7 } from '@e2e-dev/core/lib/internal/ids';
import { compareTests, type Report1Document, type ReportResult, type ReportSerialGroup } from './build.ts';
import { combineReportUsage, runDuration } from './fold.ts';
import type { ShardInput } from './merge-input.ts';
import { summarizeResults } from './summary.ts';

type Run = Report1Document['run'];
type ShardRows = { readonly input: ShardInput; readonly rows: ReportResult[] };
type Merge = { readonly report: Report1Document; readonly warnings: readonly string[] };

function pairKey(row: ReportResult): string {
  return JSON.stringify([row.kind, row.testId, row.targetId, row.agent]);
}

function assertUniqueIds(rows: readonly { readonly id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`${label} ${row.id}`);
    ids.add(row.id);
  }
}

function groupRows(rows: readonly ReportResult[]): Map<string, ReportResult[]> {
  const groups = new Map<string, ReportResult[]>();
  for (const row of rows) {
    const key = pairKey(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

const SETUP_VERDICTS: readonly ReportResult['status'][] = ['passed', 'flaky', 'skipped', 'interrupted', 'timed-out', 'failed'];

function mergeSetup(owners: readonly ShardRows[]): ReportResult {
  const rows = owners.flatMap(({ rows: owned }) => owned);
  const worst = rows.reduce((a, b) => SETUP_VERDICTS.indexOf(a.status) >= SETUP_VERDICTS.indexOf(b.status) ? a : b);
  const attempts = owners.flatMap(({ input, rows: owned }) =>
    owned.flatMap((row) => row.attempts.map((attempt) => ({ ...attempt, shard: input.shard.index }))),
  ).map((attempt, index) => ({ ...attempt, index }));
  return { ...worst, attempts };
}

/** Select the owning shard even when a test filter left its result unselected. */
function owner(candidates: readonly ShardRows[], key: string): ShardRows {
  const owners = candidates.filter(({ rows }) => rows.some((row) => row.skip?.otherShard !== true));
  const globallyLeftOut = ({ rows }: ShardRows): boolean =>
    rows.every((row) => row.selected === false && row.skip?.otherShard !== true && row.skip?.filter === undefined);
  if (owners.length === candidates.length && owners.every(globallyLeftOut)) return owners[0]!;
  const [soleOwner] = owners;
  if (soleOwner !== undefined && owners.length === 1 && !globallyLeftOut(soleOwner)) return soleOwner;
  throw new Error(`incompatible shard selection for ${key}: expected one owning shard`);
}

function checkCoverage(inputs: readonly ShardInput[]): void {
  const first = inputs[0]!;
  const runIds = new Set<string>();
  for (const [position, input] of inputs.entries()) {
    if (input.shard.total !== first.shard.total) throw new Error('shard totals disagree');
    if (input.shard.index === inputs[position - 1]?.shard.index) throw new Error(`duplicate shard ${input.shard.index}`);
    if (runIds.has(input.document.run.id)) throw new Error(`shard ${input.shard.index} repeats another shard's run id`);
    runIds.add(input.document.run.id);
  }
  // Report the first gap without walking a potentially large declared total.
  const gap = inputs.findIndex((input, index) => input.shard.index !== index + 1);
  if (gap !== -1 || inputs.length !== first.shard.total) {
    const missing = gap === -1 ? inputs.length + 1 : gap + 1;
    throw new Error(`missing shard ${missing} of ${first.shard.total}; download the output of every shard from this CI run`);
  }
}

function checkRun(first: Run, other: Run, index: number): void {
  const targets = (run: Run) => run.targets.map(({ id, platform, environment, baseOrigin }) => JSON.stringify([id, platform, environment, baseOrigin])).toSorted();
  if (other.project.id !== first.project.id) throw new Error(`shard ${index} has a different project id`);
  if (other.runner.version !== first.runner.version) throw new Error(`shard ${index} has a different runner version`);
  if (other.vcs?.commit !== first.vcs?.commit) throw new Error(`shard ${index} has a different commit`);
  if (JSON.stringify(targets(first)) !== JSON.stringify(targets(other))) throw new Error(`shard ${index} has different targets`);
}

function mergeResults(inputs: readonly ShardInput[]): { results: ReportResult[]; serialGroups: ReportSerialGroup[] } {
  const rows = new Map<string, ShardRows[]>();
  const setupAgents = new Map<string, string>();
  const groups = new Map<ShardInput, Map<string, ReportSerialGroup>>();
  for (const input of inputs) {
    assertUniqueIds(input.document.run.serialGroups, `shard ${input.shard.index} repeats serial group id`);
    assertUniqueIds(input.document.run.results, `shard ${input.shard.index} repeats result id`);
    for (const row of input.document.run.results) {
      if (row.kind !== 'setup') continue;
      const key = JSON.stringify([row.testId, row.targetId]);
      const agent = setupAgents.get(key);
      if (agent !== undefined && agent !== row.agent) throw new Error(`incompatible setup agents for ${key}`);
      setupAgents.set(key, row.agent);
    }
    groups.set(input, new Map(input.document.run.serialGroups.map((group) => [group.id, group])));
    for (const [key, candidates] of groupRows(input.document.run.results)) {
      const entry = { input, rows: candidates };
      const existing = rows.get(key);
      if (existing === undefined) rows.set(key, [entry]);
      else existing.push(entry);
    }
  }
  const results: ReportResult[] = [];
  const serialGroups = new Map<string, { group: ReportSerialGroup; shard: number }>();
  for (const [key, candidates] of rows) {
    if (candidates[0]?.rows[0]?.kind === 'setup') {
      const byId = new Map<string, ShardRows[]>();
      for (const { input, rows: setups } of candidates) {
        for (const row of setups) {
          const runs = byId.get(row.id) ?? [];
          runs.push({ input, rows: [row] });
          byId.set(row.id, runs);
        }
      }
      for (const setups of byId.values()) {
        const selected = setups.filter(({ rows: [row] }) => row?.selected);
        results.push(mergeSetup(selected.length > 0 ? selected : setups.slice(0, 1)));
      }
      continue;
    }
    if (candidates.length !== inputs.length) throw new Error(`incompatible shard selection: ${key} is absent from one or more shards`);
    const owned = owner(candidates, key);
    for (const row of owned.rows) {
      if (row.skip?.otherShard === true) continue;
      const groupId = row.serialGroupId;
      if (groupId !== undefined) {
        const group = groups.get(owned.input)?.get(groupId);
        if (group === undefined) throw new Error(`shard ${owned.input.shard.index} is missing serial group ${groupId}`);
        const existing = serialGroups.get(groupId);
        if (existing !== undefined && existing.group !== group) throw new Error(`serial group ${groupId} spans shards`);
        serialGroups.set(groupId, { group, shard: owned.input.shard.index });
      }
      const shard = owned.input.shard.index;
      results.push({
        ...row,
        ...(row.selected || row.skip?.filter !== undefined ? { shard } : {}),
        attempts: row.attempts.map((attempt) => ({ ...attempt, shard })),
      });
    }
  }
  return {
    results,
    serialGroups: [...serialGroups.values()].map(({ group, shard }) => ({
      ...group,
      attempts: group.attempts.map((attempt) => ({ ...attempt, shard })),
    })),
  };
}

export function mergeShardReports(shards: readonly ShardInput[]): Merge {
  const inputs = shards.toSorted((a, b) => a.shard.index - b.shard.index);
  checkCoverage(inputs);
  const repeatCounts = new Set(inputs.flatMap((input) => input.repeatEach === undefined ? [] : [input.repeatEach]));
  if (repeatCounts.size > 1) throw new Error('shards used different repeat counts; use the same --repeat-each for each shard');
  const first = inputs[0]!.document.run;
  const warnings: string[] = [];
  for (const { shard, document: { run } } of inputs.slice(1)) {
    checkRun(first, run, shard.index);
    if (run.project.configDigest !== first.project.configDigest) warnings.push(`shard ${shard.index} has a different config digest`);
  }
  const { results, serialGroups } = mergeResults(inputs);
  assertUniqueIds(results, 'merged report repeats result id');
  const targetOrder = new Map(first.targets.map((target, index) => [target.id, index]));
  results.sort((a, b) =>
    compareTests(a, b) || (targetOrder.get(a.targetId) ?? 0) - (targetOrder.get(b.targetId) ?? 0) || a.repeat - b.repeat,
  );
  const runs = inputs.map((input) => input.document.run);
  const summary = summarizeResults(results, serialGroups);
  const errors = runs.flatMap((run) => run.errors);
  const resultExitCode = summary.interrupted > 0 ? 130 : summary.failed > 0 ? 1 : 0;
  const exitCode = combineExitCodes([...runs.map((run) => run.exitCode), resultExitCode]);
  const nonPassing = runs.filter((run) => run.exitCode !== 0);
  const blocked = nonPassing.length > 0 && nonPassing.every((run) => run.status === 'blocked') && errors.length === 0;
  const status = exitCode === 0 ? 'passed' : exitCode === 130 ? 'interrupted' : blocked ? 'blocked' : exitCode === 1 ? 'failed' : 'error';
  const usage = runs.slice(1).reduce((total, run) => combineReportUsage(total, run.usage, results.length), { ...first.usage, discoveredResults: results.length });
  const times = runs.map((run) => [run.startedAt, run.finishedAt] as const);
  const startedAt = times.map(([start]) => start).toSorted()[0]!;
  const finishedAt = times.map(([, finish]) => finish).toSorted().at(-1)!;
  return {
    warnings,
    report: {
      schemaVersion: 'report-1',
      run: {
        id: uuidv7(),
        specVersion: first.specVersion,
        runner: first.runner,
        project: first.project,
        environment: first.environment,
        ...(first.vcs === undefined ? {} : { vcs: first.vcs }),
        startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        status,
        exitCode,
        targets: first.targets,
        limits: first.limits,
        results,
        serialGroups,
        errors,
        summary,
        usage,
        extensions: {
          'e2e.merge': {
            shardDurationMs: runs.reduce((sum, run) => sum + runDuration(run), 0),
            shards: inputs.map(({ shard: { index }, document: { run } }) => ({
              index, id: run.id, status: run.status, exitCode: run.exitCode,
              configDigest: run.project.configDigest,
              changes: run.changes, filters: run.filters,
            })),
          },
        },
      },
    },
  };
}
