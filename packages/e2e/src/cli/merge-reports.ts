import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveOutputDir, resolveSecrets } from '@e2e-dev/core/lib/config/resolve';
import { errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { realpathOfExisting } from '@e2e-dev/core/lib/internal/paths';
import { outputLayout } from '@e2e-dev/core/lib/run/output';
import { redactError, registerStaticSecrets } from '@e2e-dev/core/lib/run/secrecy';
import { discoverConfig, loadConfigModule } from '../config/load.ts';
import { resolveReporters } from '../config/resolve-run.ts';
import { builtinId } from '../report/builtin-id.ts';
import { copyMergedArtifacts, exists, inside } from '../report/merge-artifacts.ts';
import { readShard } from '../report/merge-input.ts';
import { mergeShardReports } from '../report/merge.ts';
import { writeTracePages } from '../report/traces.ts';
import { posixRelative, writeJsonReport } from '../report/write.ts';
import { hostReporters } from '../run/reporter-host.ts';
import type { BuiltinReporter } from '../run-types.ts';
import { claimRunnerOutput } from './run-output.ts';

interface MergeOptions {
  readonly config?: string;
  readonly output: string;
  readonly reporter?: readonly BuiltinReporter[];
}

export async function mergeReports(directories: readonly string[], options: MergeOptions): Promise<number> {
  const terminal = claimRunnerOutput();
  try {
    const cwd = process.cwd();
    const inputs = [];
    for (const directory of directories) inputs.push(await readShard(path.resolve(cwd, directory)));
    const { report, warnings } = mergeShardReports(inputs);
    const discovered = discoverConfig(cwd, options.config);
    const outputDir = resolveOutputDir(undefined, options.output, discovered.projectRoot);
    const output = realpathOfExisting(outputDir);
    if (await exists(outputDir) || inputs.some(({ directory }) => directory === output || inside(directory, output))) {
      throw new Error('--output must be a new directory outside the shard inputs');
    }
    const reporters = await terminal.withholdDuring(async () => {
      const raw = discovered.configPath === undefined ? undefined : await loadConfigModule(discovered.configPath);
      if (raw !== undefined) registerStaticSecrets(resolveSecrets(raw, process.env, 'report').allSecrets);
      const configured = resolveReporters(
        { reporters: raw?.reporters ?? [] },
        options.reporter === undefined ? {} : { reporters: options.reporter },
      );
      if (configured.some((reporter) => builtinId(reporter) === 'json')) terminal.reserveStdout();
      return configured;
    });
    for (const reporter of reporters) {
      if (reporter.onRunFinished === undefined && reporter.reportFiles === undefined && reporter.onSummary === undefined) {
        throw new Error(`reporter "${reporter.name}" needs live events; choose a finished-run reporter`);
      }
    }
    for (const warning of warnings) process.stderr.write(`e2e: warning: ${warning}\n`);

    // Publish only after the report and all its local evidence are complete.
    await mkdir(path.dirname(output), { recursive: true });
    const staging = await mkdtemp(path.join(path.dirname(output), '.e2e-merge-'));
    const layout = outputLayout(output);
    let traces;
    try {
      const pending = outputLayout(staging);
      const traced = await copyMergedArtifacts(report, inputs, pending.results);
      const stagedTraces = await writeTracePages(report, traced, {
        projectRoot: staging,
        resultsRoot: pending.results,
      });
      traces = new Map([...stagedTraces].map(([id, file]) => [id, posixRelative(discovered.projectRoot, path.join(output, file))]));
      await writeJsonReport(pending.report, report);
      if (await exists(output)) throw new Error('--output must be a new directory');
      await rename(staging, output);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    const { exitCode, status, summary } = report.run;
    const host = hostReporters(reporters, {
      processOutput: terminal,
      quiet: true,
      redact: redactError,
      onEvent: undefined,
      timeoutMs: 30_000,
      force: new AbortController().signal,
    });
    await host.finish({
      report,
      status,
      exitCode,
      projectRoot: discovered.projectRoot,
      outputDir: output,
      reportPath: layout.report,
      artifactsRoot: layout.results,
      aiTracePath: undefined,
      traces,
      redact: redactError,
    });
    process.stderr.write(`Merged ${inputs.length} shard reports: ${status} (${summary.selected} selected, ${summary.failed} failed)\n`);
    return exitCode;
  } catch (cause) {
    process.stderr.write(`e2e merge-reports: ${redactError(errorMessage(cause))}\n`);
    return 2;
  } finally {
    terminal.end();
  }
}
