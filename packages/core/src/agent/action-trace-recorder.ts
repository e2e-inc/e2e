import type { SemanticNode } from '../engine/surface.ts';
import { pressedTextCharacter } from '../internal/keys.ts';
import type { JsonValue } from '../types.ts';
import type { RecordableAction } from './actions.ts';
import { derivedJoinReason, derivedReason } from './derived.ts';
import type { ObservationFeed } from './observation-feed.ts';
import type { StepTraceSession } from './step-cache.ts';

const MAX_TYPED_RUN = 12;

type InputPurpose = SemanticNode['inputPurpose'];

interface TypedInput {
  readonly value: string;
  readonly inputPurpose: InputPurpose;
  readonly keypress: boolean;
}

function typedInput(action: RecordableAction, focusedPurpose: InputPurpose): TypedInput | undefined {
  switch (action.name) {
    case 'type':
      return { value: action.value, inputPurpose: action.node.inputPurpose, keypress: false };
    case 'typeText':
      return { value: action.value, inputPurpose: focusedPurpose, keypress: false };
    case 'press':
    case 'pressKey': {
      const value = pressedTextCharacter(action.key);
      if (value === undefined) return undefined;
      const inputPurpose = action.name === 'press' ? action.node.inputPurpose : focusedPurpose;
      return { value, inputPurpose, keypress: true };
    }
    default:
      return undefined;
  }
}

function keepsTypedRun(action: RecordableAction): boolean {
  if (action.name === 'tap' || action.name === 'tapAt') return true;
  return (action.name === 'press' || action.name === 'pressKey') && action.key === 'Tab';
}

type TraceObservations = Pick<ObservationFeed, 'oneTimeCodeShown' | 'shownText' | 'pixelsShown'>;
type TraceInputs = { readonly instruction: string; readonly params: Readonly<Record<string, JsonValue>> | undefined };

/** Records actions and keeps enough recent input to judge values typed across fields. */
export class ActionTraceRecorder {
  private readonly typedRun: { readonly index: number; readonly value: string }[] = [];

  reset(): void {
    this.typedRun.length = 0;
  }

  record(
    action: RecordableAction,
    trace: StepTraceSession,
    feed: TraceObservations,
    inputs: TraceInputs,
    replaying: boolean,
  ): void {
    // Replayed values are already part of the recording rather than fresh input.
    const input = replaying ? undefined : typedInput(action, feed.oneTimeCodeShown ? 'one-time-code' : undefined);
    if (input === undefined) {
      if (!keepsTypedRun(action)) this.reset();
      trace.record(action);
      return;
    }

    const { value, inputPurpose, keypress } = input;
    const { instruction, params } = inputs;
    const index = trace.recordedCount;
    // An unmarked key is judged only as part of a run so ordinary single keys replay.
    const shown = feed.shownText();
    const derived = !keypress || inputPurpose === 'one-time-code'
      ? derivedReason(value, instruction, params, {
          shown,
          pixels: feed.pixelsShown,
          ...(inputPurpose === undefined ? {} : { inputPurpose }),
        })
      : undefined;
    if (derived === undefined) trace.record(action);
    else trace.recordDerivedGap(derived);

    if (index === undefined) return;
    this.typedRun.push({ index, value });
    if (this.typedRun.length > MAX_TYPED_RUN) this.typedRun.shift();
    for (let start = 0; start < this.typedRun.length - 1; start += 1) {
      const joined = this.typedRun.slice(start).map((typed) => typed.value).join('');
      const reason = derivedJoinReason(joined, instruction, params, feed.shownText());
      if (reason === undefined) continue;
      trace.gapFrom(this.typedRun[start]!.index, reason);
      return;
    }
  }
}
