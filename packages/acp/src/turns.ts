/** What a step and a judgment both need of one prompt turn. */

import type { ExecutorModelCall } from 'e2e';
import type { Usage } from '@agentclientprotocol/sdk/unstable';
import type { AcpSession, PromptImage, TurnReport } from './session.ts';

/** Waits for `promise`, or rejects when `signal` aborts first. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort!));
}

/** One prompt turn as one model call, with what the agent reported of it. */
export function turnUsage(session: AcpSession, report: TurnReport): ExecutorModelCall {
  const usage = report.usage;
  return {
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    ...(session.agentName === undefined ? {} : { provider: session.agentName }),
    ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
    ...(usage === undefined
      ? {}
      : {
          inputTokens: inputTokens(usage),
          outputTokens: usage.outputTokens,
          ...(usage.cachedReadTokens == null ? {} : { cacheReadTokens: usage.cachedReadTokens }),
          ...(usage.cachedWriteTokens == null ? {} : { cacheWriteTokens: usage.cachedWriteTokens }),
        }),
    ...(report.costUsd === undefined ? {} : { estimatedCostUsd: report.costUsd }),
  };
}

/**
 * The turn's input tokens with the cached ones included, as e2e counts them.
 * ACP leaves open whether an agent's `inputTokens` include them: the Claude
 * adapter's do not (its total adds the cache on top), Codex's do (its total
 * is input and output alone).
 */
function inputTokens(usage: Usage): number {
  const cached = (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0);
  const cacheApart = cached > 0 && usage.totalTokens >= usage.inputTokens + usage.outputTokens + cached;
  return cacheApart ? usage.inputTokens + cached : usage.inputTokens;
}

/** Pixels as the base64 image an ACP prompt or an MCP tool result carries. */
export function encodeImage(pixels: { readonly data: Uint8Array; readonly mediaType: string }): PromptImage {
  return { data: Buffer.from(pixels.data).toString('base64'), mimeType: pixels.mediaType };
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
