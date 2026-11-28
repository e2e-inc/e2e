/** Model adapter contract. */

import type { JSONSchema7 } from 'ai';
import type { ProviderOptions } from '../../types.ts';
import { AgentError } from '../error.ts';
import type { ExecutorImage } from '../executor.ts';
import type { ProtocolValidation } from '../protocol.ts';

/** Token accounting for one model call. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Prompt-cache split of `inputTokens`, when the provider reports one. */
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly accounting: 'provider' | 'adapter-upper-bound';
  readonly estimatedCostUsd: number | undefined;
}

/** Provenance recorded for every model-backed step. */
export interface ModelProvenance {
  readonly provider: string;
  readonly model: string;
  /**
   * `local` for in-process adapters, `provider-default` when a caller-supplied
   * model instance owns its own transport, otherwise an absolute endpoint URI.
   */
  readonly endpoint: string;
  readonly adapterVersion: string;
}

/** Untrusted pixel evidence sent alongside the prompt; its CSS pixel geometry feeds the pre-flight token bound. */
export type ModelImage = ExecutorImage;

/** One bounded, stateless model request. There is no shared transcript. */
export interface ModelCall<Value> {
  /** Trusted runner policy followed by trusted project context. */
  readonly system: string;
  /** Untrusted evidence and the method instruction. */
  readonly prompt: string;
  /**
   * Untrusted image evidence attached to the same user message. Present only
   * for vision calls; a non-multimodal provider rejects the request.
   */
  readonly images?: readonly ModelImage[] | undefined;
  readonly schemaName: string;
  /**
   * Closed response grammar sent to the provider as a structured-output
   * schema. Omitted when only the runner can validate the payload, in which
   * case the adapter parses one JSON object from the response text.
   */
  readonly schema: JSONSchema7 | undefined;
  readonly validate: (value: unknown) => ProtocolValidation<Value>;
  readonly maxOutputTokens: number;
  readonly maxInputTokens: number;
  /** Provider options from `agent.providerOptions`, passed through as-is. */
  readonly providerOptions?: ProviderOptions | undefined;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Provider transport retries; default `TRANSPORT_RETRIES`. */
  readonly maxRetries?: number | undefined;
}

export interface ModelResult<Value> {
  readonly value: Value;
  readonly usage: ModelUsage;
  /** The model's reasoning text for the call, when it produced one. */
  readonly reasoning: string | undefined;
}

export interface ModelAdapter {
  readonly provenance: ModelProvenance;
  /** Performs exactly one model request and validates its response. */
  generate<Value>(call: ModelCall<Value>): Promise<ModelResult<Value>>;
}

/**
 * Raised when a provider response cannot be parsed or fails the closed
 * grammar. The raw text is carried so the caller may spend remaining budget on
 * one repair attempt.
 */
export class ModelOutputInvalidError extends AgentError {
  readonly rawText: string | undefined;

  constructor(issue: string, options: { rawText?: string; cause?: unknown } = {}) {
    super('MODEL_OUTPUT_INVALID', issue, options.cause === undefined ? {} : { cause: options.cause });
    this.rawText = options.rawText;
  }
}

/**
 * Parses exactly one JSON object from response text, tolerating a code fence.
 * Model text is never evaluated as code.
 */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new ModelOutputInvalidError('response text is not a single JSON value', {
      rawText: text,
      cause,
    });
  }
}

/** A text reply as the call's value: one JSON value that passes the call's own validation. */
export function parseValidated<Value>(call: Pick<ModelCall<Value>, 'validate'>, text: string): Value {
  const validation = call.validate(parseJsonObject(text));
  if (!validation.ok) throw new ModelOutputInvalidError(validation.issue, { rawText: text });
  return validation.value;
}

/**
 * The pre-flight ceiling of one request: its input upper bound, or
 * STEP_BUDGET_EXHAUSTED before anything is sent when that is over the agent's
 * `maxInputTokens`.
 */
export function inputUpperBound(call: Pick<ModelCall<unknown>, 'system' | 'maxInputTokens'>, prompt: string, images: readonly ModelImage[]): number {
  const bound = tokenUpperBound(call.system) + tokenUpperBound(prompt) + images.reduce((total, image) => total + imageTokenUpperBound(image), 0);
  if (bound > call.maxInputTokens) {
    throw new AgentError('STEP_BUDGET_EXHAUSTED', `model input upper bound ${bound} exceeds the agent's maxInputTokens ${call.maxInputTokens}`);
  }
  return bound;
}

/**
 * Conservative token upper bound. UTF-8 byte length bounds every byte-level
 * tokenizer from above, so it is used when a provider reports no usage and for
 * the pre-flight ceiling: unavailable accounting fails before the request.
 *
 * Every budget that mixes with this one — reserves, ledger size, observation
 * size — is therefore in the same byte-scaled units, not in real tokens.
 */
export function tokenUpperBound(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Side of the square patch tile-based vision encoders consume an image in. */
const IMAGE_TILE_PX = 28;

/**
 * Conservative token bound for one image. Vision providers bill images by
 * fixed-size patches rather than bytes, so the count of patches covering the
 * image bounds every such encoder from above closely enough to keep a vision
 * call inside the agent's `maxInputTokens`. Compressed byte length would be
 * meaningless here: a blank screenshot is small and a photograph is not, while
 * both cost the same number of patches.
 */
export function imageTokenUpperBound(image: { width: number; height: number }): number {
  return (
    Math.ceil(Math.max(1, image.width) / IMAGE_TILE_PX) *
    Math.ceil(Math.max(1, image.height) / IMAGE_TILE_PX)
  );
}
