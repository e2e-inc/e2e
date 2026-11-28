/**
 * Recognizes a provider refusing a forced tool choice. The act loop asks for
 * a tool call on every turn (`toolChoice: 'required'`) and names
 * `complete_step` on the final ones; some models reject that request shape
 * outright (Anthropic's Claude Fable 5.1 answers HTTP 400 with
 * `tool_choice: type "tool" and "any" are not supported for this model.`;
 * DeepSeek's V4 models think by default and answer a forced choice with
 * `Thinking mode does not support this tool_choice`; Meta's Muse Spark models
 * answer ``only `"auto"` is supported for `tool_choice` ``), and a gateway
 * forwards the provider's words.
 *
 * The loop reacts to this refusal differently from any other provider
 * failure: the same request with `toolChoice: 'auto'` and an instruction to
 * answer with tool calls can still succeed, where a 5xx needs only time.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { realmSlot } from '../../internal/realm-slot.ts';

const FORCED_CHOICE_PATTERNS: readonly RegExp[] = [
  /tool_choice.*not supported/i, // Anthropic
  /does not support (?:this |the )?tool_choice/i, // DeepSeek V4 in thinking mode (its default)
  /tool_choice.*(?:unsupported|is not allowed|cannot be)/i, // OpenAI-compatible proxies
  /only\W+auto\W+is supported for\W+tool_choice/i, // Meta Muse Spark
  /(?:forced|required) tool (?:choice|call|use).*not supported/i, // generic
  /does not support (?:forced|required) tool/i, // generic
];

/**
 * Whether a call warning says the provider sent `auto` in place of the
 * forced choice it was asked for. The AI SDK's Anthropic provider does this
 * itself for models it knows reject forced tool use (Claude Sonnet 5.5), so
 * the request succeeds and no refusal ever reaches the loop.
 */
export function isForcedToolChoiceDowngraded(warning: { readonly type: string; readonly feature?: string }): boolean {
  return warning.type === 'unsupported' && warning.feature === 'toolChoice';
}

/**
 * Whether the AI SDK threw `AI_ToolChoiceViolationError`: a reply that broke
 * the forced tool choice. Only the AI SDK 7.0.88 and later throws it, and it
 * is matched by name, since earlier 7.x releases, which the peer range
 * allows, export no such class.
 */
export function isToolChoiceViolation(
  error: unknown,
): error is { readonly finishReason?: unknown; readonly content?: unknown } {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AI_ToolChoiceViolationError';
}

/**
 * Whether a turn under a forced choice came back as a finished reply without
 * a tool call. That is how a downgrading provider's prose answer surfaces; a
 * reply cut off by the token limit or a content filter says nothing about the
 * provider and does not count.
 */
export function isForcedToolCallSkipped(error: unknown): error is { readonly content?: readonly unknown[] } {
  return isToolChoiceViolation(error) && error.finishReason === 'stop';
}

/**
 * Whether a turn forced to call `complete_step` called other tools only. The
 * AI SDK throws `AI_ToolChoiceViolationError` for that too, with the reply's
 * raw content; it is the model breaking the protocol, as when it names a tool
 * the turn does not offer, not the provider failing.
 */
export function isForcedToolCallMismatched(error: unknown): error is { readonly content: readonly unknown[] } {
  return (
    isToolChoiceViolation(error) &&
    Array.isArray(error.content) &&
    error.content.some((part: unknown) => typeof part === 'object' && part !== null && 'type' in part && part.type === 'tool-call')
  );
}

/** Longest cause chain walked; a wrapped error rarely nests deeper. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Whether a provider failure says the model does not accept a forced tool
 * choice. Reads the message and the raw response body of the error and of
 * everything it wraps (`cause`, or the last attempt of a spent retry chain).
 * Only a 4xx counts: a gateway or proxy that fails for its own reasons while
 * quoting the request never reads as a model limitation.
 */
export function isForcedToolChoiceRejected(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (describesRejection(current)) return true;
    if (typeof current !== 'object') return false;
    const wrapper = current as { cause?: unknown; lastError?: unknown };
    current = wrapper.cause ?? wrapper.lastError;
  }
  return false;
}

function describesRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { message?: unknown; statusCode?: unknown; status?: unknown; responseBody?: unknown };
  const status = record.statusCode ?? record.status;
  if (typeof status === 'number' && (status < 400 || status >= 500)) return false;
  return [record.message, record.responseBody].some(
    (text) => typeof text === 'string' && FORCED_CHOICE_PATTERNS.some((pattern) => pattern.test(text)),
  );
}

interface SdkWarning {
  readonly type: string;
  readonly feature?: string;
  readonly details?: string;
  readonly setting?: string;
  readonly message?: string;
}

interface SdkWarningOptions {
  readonly warnings: readonly SdkWarning[];
  readonly provider?: string;
  readonly model?: string;
}

type SdkWarningLogger = (options: SdkWarningOptions) => void;
type SdkWarningsGlobal = false | SdkWarningLogger | undefined;

interface WarningFilterState {
  depth: number;
  active: boolean;
  previous: SdkWarningsGlobal;
  hasLoggedBefore: boolean;
  readonly emittedDeprecationCodes: Set<string>;
  readonly scope: AsyncLocalStorage<boolean>;
  readonly wrapper: SdkWarningLogger;
}

const warningFilterSlot = realmSlot<WarningFilterState>('e2e.ai-sdk-warning-filter.v1');

const FIRST_WARNING_INFO_MESSAGE =
  'AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false.';

const DEPRECATION_CODES = new Map<string, string>([
  ['generateObject', 'AISDK_DEP_GENERATE_OBJECT'],
  ['streamObject', 'AISDK_DEP_STREAM_OBJECT'],
  ['experimental_generateSpeech', 'AISDK_DEP_EXPERIMENTAL_GENERATE_SPEECH'],
  ['experimental_transcribe', 'AISDK_DEP_EXPERIMENTAL_TRANSCRIBE'],
  ['"image" content part', 'AISDK_DEP_IMAGE_CONTENT_PART'],
  ['"tool-result" content of type "file-data"', 'AISDK_DEP_TOOL_RESULT_FILE_DATA'],
  ['"tool-result" content of type "file-url"', 'AISDK_DEP_TOOL_RESULT_FILE_URL'],
  ['"tool-result" content of type "file-id"', 'AISDK_DEP_TOOL_RESULT_FILE_ID'],
  ['"tool-result" content of type "file-reference"', 'AISDK_DEP_TOOL_RESULT_FILE_REFERENCE'],
  ['"tool-result" content of type "image-data"', 'AISDK_DEP_TOOL_RESULT_IMAGE_DATA'],
  ['"tool-result" content of type "image-url"', 'AISDK_DEP_TOOL_RESULT_IMAGE_URL'],
  ['"tool-result" content of type "image-file-id"', 'AISDK_DEP_TOOL_RESULT_IMAGE_FILE_ID'],
  ['"tool-result" content of type "image-file-reference"', 'AISDK_DEP_TOOL_RESULT_IMAGE_FILE_REFERENCE'],
  ['rawInput in output-error UI message parts', 'AISDK_DEP_UI_MESSAGE_RAW_INPUT'],
]);

function encodeCodePart(value: string): string {
  return value.replace(
    /[^a-zA-Z0-9]/g,
    (character) => `_${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  );
}

function getDeprecationCode(setting: string, provider?: string): string {
  if (provider == null) return DEPRECATION_CODES.get(setting) ?? `AISDK_DEP_SETTING_${encodeCodePart(setting)}`;
  return `AISDK_DEP_PROVIDER_${encodeCodePart(provider)}__${encodeCodePart(setting)}`;
}

function emitSdkWarning(message: string, type: 'Warning' | 'DeprecationWarning', code?: string): void {
  if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
    process.emitWarning(message, code === undefined ? { type } : { type, code });
  } else {
    console.warn(code === undefined ? message : `[${code}] ${message}`);
  }
}

function formatSdkWarning(warning: SdkWarning, provider?: string, model?: string): string {
  const prefix = `AI SDK Warning${provider != null && model != null ? ` (${provider} / ${model})` : ''}:`;
  switch (warning.type) {
    case 'unsupported': {
      const base = `${prefix} The feature "${String(warning.feature)}" is not supported.`;
      return warning.details ? `${base} ${warning.details}` : base;
    }
    case 'compatibility': {
      const base = `${prefix} The feature "${String(warning.feature)}" is used in a compatibility mode.`;
      return warning.details ? `${base} ${warning.details}` : base;
    }
    case 'deprecated':
      return `${prefix} Deprecated: "${String(warning.setting)}". ${String(warning.message ?? '')}`;
    case 'other':
      return `${prefix} ${String(warning.message ?? '')}`;
    default:
      return `${prefix} ${JSON.stringify(warning, null, 2)}`;
  }
}

function getWarningFilterState(): WarningFilterState {
  let state = warningFilterSlot.get(globalThis);
  if (state !== undefined) return state;
  const created: WarningFilterState = {
    depth: 0,
    active: false,
    previous: undefined,
    hasLoggedBefore: false,
    emittedDeprecationCodes: new Set(),
    scope: new AsyncLocalStorage<boolean>(),
    wrapper: (options) => {
      const remaining =
        created.scope.getStore() === true
          ? options.warnings.filter((warning) => !isForcedToolChoiceDowngraded(warning))
          : options.warnings;
      if (remaining.length === 0) return;
      if (typeof created.previous === 'function') {
        created.previous({ ...options, warnings: remaining });
        return;
      }
      if (!created.hasLoggedBefore) {
        created.hasLoggedBefore = true;
        emitSdkWarning(FIRST_WARNING_INFO_MESSAGE, 'Warning');
      }
      for (const warning of remaining) {
        const code =
          warning.type === 'deprecated' ? getDeprecationCode(String(warning.setting ?? ''), options.provider) : undefined;
        if (code !== undefined) {
          if (created.emittedDeprecationCodes.has(code)) continue;
          created.emittedDeprecationCodes.add(code);
        }
        const message = formatSdkWarning(warning, options.provider, options.model);
        const type = warning.type === 'deprecated' ? 'DeprecationWarning' : 'Warning';
        emitSdkWarning(message, type, code);
      }
    },
  };
  warningFilterSlot.set(globalThis, created);
  return created;
}

/**
 * Suppresses the AI SDK's `unsupported` / `toolChoice` warning within the
 * originating async context while `fn` runs, since `ToolLoop` already handles
 * that downgrade and records a step note. Unrelated async callers and contexts
 * exited via `withoutFilteredToolChoiceWarnings` retain their warnings, and
 * other warnings pass through to any user-configured `AI_SDK_LOG_WARNINGS`
 * logger or the default AI SDK warning emitter.
 */
export async function withFilteredToolChoiceWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const globalWarnings = globalThis as { AI_SDK_LOG_WARNINGS?: SdkWarningsGlobal };
  const state = getWarningFilterState();
  if (state.depth === 0) {
    const current = globalWarnings.AI_SDK_LOG_WARNINGS;
    if (current === false) {
      state.active = false;
    } else {
      state.previous = current;
      state.active = true;
      globalWarnings.AI_SDK_LOG_WARNINGS = state.wrapper;
    }
  }
  state.depth += 1;
  try {
    return await state.scope.run(true, fn);
  } finally {
    state.depth -= 1;
    if (state.depth === 0 && state.active) {
      if (globalWarnings.AI_SDK_LOG_WARNINGS === state.wrapper) {
        if (state.previous === undefined) {
          delete globalWarnings.AI_SDK_LOG_WARNINGS;
        } else {
          globalWarnings.AI_SDK_LOG_WARNINGS = state.previous;
        }
      }
      state.previous = undefined;
      state.active = false;
    }
  }
}

/**
 * Exits the active tool-choice warning filter async context for `fn` so
 * nested AI SDK calls (such as those made inside custom tools) retain their
 * own `toolChoice` warnings.
 */
export function withoutFilteredToolChoiceWarnings<T>(fn: () => T): T {
  const state = warningFilterSlot.get(globalThis);
  if (state === undefined || state.scope.getStore() !== true) return fn();
  return state.scope.exit(fn);
}
