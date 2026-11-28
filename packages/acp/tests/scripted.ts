/** What the executor and judgment tests share: a scripted agent, its log, and an attempt a test ends. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, vi } from 'vitest';
import { acp } from '../src/index.ts';
import type { AcpOptions } from '../src/types.ts';

export const AGENT = fileURLToPath(new URL('./fixtures/scripted-agent.ts', import.meta.url));
export const cleanups: (() => void)[] = [];

/** Waits on the scripted agent: a child process, which a busy machine can start or answer seconds late. */
export function eventually<T>(check: () => T): Promise<T> {
  return vi.waitFor(check, { timeout: 15_000 });
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

/** A scripted agent: one list of moves per prompt turn, and the log it writes. */
export function scripted(turns: unknown[][] | Record<string, unknown[]>, extra: Partial<AcpOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-acp-test-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const logFile = join(directory, 'agent.jsonl');
  const executor = acp({
    command: process.execPath,
    args: [AGENT],
    ...extra,
    env: { ACP_SCRIPT: JSON.stringify(turns), ACP_LOG: logFile, ...extra.env },
  });
  const log = (): Record<string, unknown>[] => {
    try {
      return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  return { executor, log };
}

export function attemptOf() {
  const controller = new AbortController();
  const attempt = { testId: 't', attemptId: 'a', index: 0, signal: controller.signal, memory: new Map<string, unknown>() };
  return { attempt, end: () => controller.abort() };
}

