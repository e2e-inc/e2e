/**
 * Detours in a recorded flow.
 *
 * A recording replays whatever the recording run did, a wrong turn
 * included: an agent that opened the wrong settings page, scrolled it, and
 * backed out before it took the right one passed, so its recording passes
 * on every replay too, and the wasted actions run each time without a word.
 * A detour here is the mechanical shape of that wrong turn: the flow left a
 * screen and came back to it, and nothing on the way typed, chose, or set
 * anything. Going back after a change (a detail page edited, then left) is
 * ordinary navigation and is not one.
 *
 * A return is to the same address, record ids and query included
 * (`addressKey`): from one order's page to another's and back is a visit to
 * another record, and from one order to another is no return at all. Each
 * action carries the location it ran at (`RecordedAction.at`) on entries
 * recorded since that was added, spelled with every minted segment and
 * every query value as `:id` (`routeLocation`), so a token a URL carried is
 * not stored; the detours are found on the run's own locations before that
 * and kept as spans (`ActionTrace.detours`). For older
 * entries, which have none, the actions alone are read for the narrowest
 * shape of the same thing: a tap or a navigate, nothing but looking around
 * after it, then `back`.
 *
 * A detour is a hint, never a verdict: an instruction that asks to look at
 * a page and return is one by design, and so is a tap that changes data and
 * returns (a delete that goes back to the list). The report and
 * `e2e cache check` name it; neither replay, recording, nor `check`'s exit
 * code treats it differently.
 */

import { bound } from '../internal/text.ts';
import { addressKey, routeLocation } from './route.ts';
import type { ActionTrace, RecordedAction } from './trace.ts';

/**
 * What the detour check reads of a trace, and which of its places (before
 * each action, then the end) hold a location as an entry stores it: one a
 * replay copied from its entry onto an action it ran without looking, or
 * every place of an entry read for the actions a hand-off ran.
 */
type DetourInput = Pick<ActionTrace, 'actions' | 'startPath' | 'endPath' | 'truncated' | 'detours'> & {
  readonly stored?: ReadonlySet<number>;
  /** Spans already settled: the scan starts in none and crosses none. */
  readonly bounds?: readonly Pick<TraceDetour, 'from' | 'to'>[];
  /**
   * Whether a trip counts, judged before the scan moves past it, so a trip
   * inside one that does not is still found: `home` is the place the scan
   * started from, `from` the action that left, `to` where it came back.
   */
  readonly counts?: (trip: { readonly home: number; readonly from: number; readonly to: number }) => boolean;
};

/** One stretch of a recording that left a screen and came back to it with nothing typed, chosen, or set on the way. */
export interface TraceDetour {
  /** Zero-based index of the first action of the detour: the one that left. */
  readonly from: number;
  /**
   * Zero-based index of the action the flow went on with once it was back,
   * or the number of actions when it came back at the end of the step.
   */
  readonly to: number;
  /** The location it left and came back to; absent when only the actions' shape shows the detour. */
  readonly at?: string;
  /** The first other location it went to; absent when only the actions' shape shows the detour. */
  readonly via?: string;
  /** `locations` when the recorded locations show it, `actions` when an entry without them is read by its actions alone. */
  readonly evidence: 'locations' | 'actions';
}

/** Verbs that put a value, a choice, or a state into the app, or that a replay cannot see into. */
const CHANGING_ACTIONS: ReadonlySet<RecordedAction['name']> = new Set<RecordedAction['name']>([
  'type',
  'typeSecret',
  'typeText',
  'select',
  'check',
  'upload',
  'drag',
  'dragAt',
  'press',
  'pressKey',
  'tool',
]);

/** Roles whose tap sets a state, as `check` and `select` would. */
const STATE_ROLES: ReadonlySet<string> = new Set([
  'checkbox',
  'switch',
  'radio',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
]);

/** Verbs that only look: what an agent does on a page it then backs out of. */
const LOOKING_ACTIONS: ReadonlySet<RecordedAction['name']> = new Set<RecordedAction['name']>([
  'scroll',
  'scrollUntil',
  'scrollTo',
  'hover',
  'hoverAt',
]);

/** Verbs that leave a screen in the shape an entry without locations is read for. */
const LEAVING_ACTIONS: ReadonlySet<RecordedAction['name']> = new Set<RecordedAction['name']>(['tap', 'doubleTap', 'tapAt', 'navigate']);

/**
 * Whether an action may have changed what the app holds, so a return after
 * it is not a detour. A tap counts when it landed on a control that holds a
 * state, by its target or, for a tap at a point, the node the point was in,
 * or when the control it reached is one: a checkbox whose label holds a
 * link ("I agree to the Terms") records the link as the control at its
 * centre and is still set by the tap. Hovering over or scrolling to such a
 * control sets nothing.
 */
function changesState(action: RecordedAction): boolean {
  if (CHANGING_ACTIONS.has(action.name)) return true;
  return tappedRoles(action).some((role) => role !== undefined && STATE_ROLES.has(role));
}

/** The roles of what a tap landed on, its own and the control it reached; none for an action that taps nothing. */
function tappedRoles(action: RecordedAction): readonly (string | undefined)[] {
  switch (action.name) {
    case 'tap':
    case 'doubleTap':
    case 'longPress':
    case 'secondaryTap':
      return [action.controlRole, action.target.role];
    case 'tapAt':
      return [action.controlRole, action.within?.target.role];
    default:
      return [];
  }
}

/**
 * Every detour in a recording, in order and never overlapping: the ones the
 * recording run found, when the entry keeps them, since a stored location
 * spells each `unique()` value as a placeholder and no longer compares the
 * way the run's did; else read by locations when any action carries one,
 * else by the actions' shape alone. With `spell`, a kept span names its
 * places as `spell` writes them: a replay's trace has its `unique()` values
 * filled in, which an entry's spelling never held.
 */
export function findDetours(trace: DetourInput, spell?: (place: string) => string): TraceDetour[] {
  if (trace.detours !== undefined) return recorded(trace, spell);
  return trace.actions.some((action) => action.at !== undefined) ? byLocations(trace) : byActions(trace.actions);
}

/**
 * The detours of a recording made again after a replay ran its first
 * `executed` actions and handed off: the spans the entry kept for those
 * actions, and the ones this run found that end where the agent took over
 * or after it, a scan that
 * starts in none of the entry's and crosses none. The entry already judged
 * the replayed actions. The ones the replay ran without looking carry the
 * location their recording had (`kept`, from `TraceRecorder.keepLocations`),
 * which reads `:id` for a record id and a query value, so comparing again
 * would lose a trip between two records the entry found, or find one to a
 * record the flow never went back to; a span that crossed one of the
 * entry's would rest on such a comparison, and would hide a trip inside it.
 */
export function findDetoursAfterReplay(
  trace: DetourInput,
  replayed: readonly Pick<TraceDetour, 'from' | 'to'>[],
  executed: number,
  kept: ReadonlySet<number>,
): TraceDetour[] {
  // A trip from a place the replay copied from the entry back to one the agent saw compares them by spelling, which
  // cannot tell a record or view from another when it holds `:id` (as `findReplayedDetours` rules at the stop).
  const unproven = (index: number) => kept.has(index) && routeLocation(trace.actions[index]?.at ?? '').includes(':id');
  const counts = ({ home, from, to }: { readonly home: number; readonly from: number; readonly to: number }) =>
    to >= executed && !unproven(home) && !unproven(from);
  const found = findDetours({ ...trace, stored: kept, bounds: replayed, counts });
  const spans = [...replayed, ...found].map(({ from, to }) => ({ from, to })).toSorted((x, y) => x.from - y.from);
  // This run's places are live addresses: named as an entry spells them, as `byLocations` names its own.
  return recorded({ ...trace, detours: spans }, routeLocation);
}

/**
 * The detours of the first `executed` actions of a recording, which a
 * replay ran before it handed off, read as a flow of their own that ends
 * where the next recorded action stood, so a trip the replay completed is
 * not merged with one it never reached. When the replay saw where it
 * stopped (`live.stop`: a screen with no recorded target, or an end that
 * never reached the recorded route), a trip that came back there counts
 * only if that screen is the one the trip left: by the address the replay
 * saw there (`live.places`), else by the recorded spelling when it holds no
 * `:id`, since `/?view=:id` tells no view from another. An end that never
 * reached its route came back to nothing. A span the recording run found
 * that ends inside them is kept as found: a stored location reads `:id`
 * for a record id and a query value, so comparing again would lose a trip
 * to another record. Only a span the hand-off cut through is read again,
 * on the stored locations, each on its own so a match outside it takes
 * none of its trips, and a trip found there counts only inside it.
 */
export function findReplayedDetours(
  trace: DetourInput,
  executed: number,
  live?: { readonly stop: string; readonly places: readonly (string | undefined)[] },
): TraceDetour[] {
  // Where the action the replay stopped at was recorded, or the recorded end when it ran them all.
  const atEnd = executed >= trace.actions.length;
  const next = atEnd ? trace.endPath : trace.actions[executed]?.at;
  const confirmed = ({ from, to }: { readonly from: number; readonly to: number }): boolean => {
    if (to < executed || live === undefined || next === undefined) return true;
    const home = live.places[from];
    if (home !== undefined) return addressKey(home) === addressKey(live.stop);
    // An end that did not match has nothing recorded to confirm a return by.
    return !atEnd && !routeLocation(next).includes(':id') && routeLocation(live.stop) === routeLocation(next);
  };
  const ran = {
    actions: trace.actions.slice(0, executed),
    ...(trace.startPath === undefined ? {} : { startPath: trace.startPath }),
    ...(next === undefined ? {} : { endPath: next }),
  };
  const spans = trace.detours;
  if (spans === undefined) return findDetours(ran);
  const finished = findDetours({ ...ran, detours: spans.filter(({ to }) => to <= executed) }, routeLocation).filter(confirmed);
  // A span the hand-off cut through, or one that came back at the stop where the replay saw it did not, is read again inside.
  const cut = spans.filter(({ from, to }) => from < executed && (executed < to || (to === executed && !finished.some((span) => span.from === from))));
  const inCut = cut.flatMap((span) => {
    // Every place here is the entry's, spelled as it stores them.
    const inside = { actions: ran.actions.slice(span.from), ...(next === undefined ? {} : { endPath: next }) };
    const stored = new Set(Array.from({ length: inside.actions.length + 1 }, (_, index) => index));
    const counts = ({ from, to }: { readonly from: number; readonly to: number }) => to + span.from <= span.to && confirmed({ from: from + span.from, to: to + span.from });
    return findDetours({ ...inside, stored, counts }).map((detour) => ({ ...detour, from: detour.from + span.from, to: detour.to + span.from }));
  });
  return [...finished, ...inCut].toSorted((a, b) => a.from - b.from);
}

/**
 * The spans the recording run kept, named by the actions' locations as
 * stored (or as `spell` writes them): the screen the span started on, and
 * the first other location it reached, which is the first known place
 * after the action that left, since `byLocations` starts a span at the last
 * action that stood home. Never by the start path, which an entry keeps
 * with its query values as the replay's anchor: a first action whose
 * location the reader dropped (one spelled past its bound) names none.
 */
function recorded(trace: DetourInput, spell: (place: string) => string = (place) => place): TraceDetour[] {
  const where = trace.actions.map((action) => action.at);
  return (trace.detours ?? []).map(({ from, to }) => {
    const home = where[from];
    const away = where.slice(from + 1, to).find((place) => place !== undefined);
    const at = home === undefined ? undefined : spell(home);
    const via = away === undefined ? undefined : spell(away);
    return { from, to, ...(at === undefined ? {} : { at }), ...(via === undefined ? {} : { via }), evidence: 'locations' as const };
  });
}

/**
 * Where the flow stood before each action, then where it ended: the first
 * action falls back to the step's start location, the last place is the
 * step's end location. An unknown place is undefined and matches nothing.
 * A recording cut at the action cap ran actions it did not keep, so its end
 * location is not where its last kept action led.
 */
function places(trace: DetourInput): (string | undefined)[] {
  const end = trace.truncated === true ? undefined : trace.endPath;
  return [...trace.actions.map((action, index) => action.at ?? (index === 0 ? trace.startPath : undefined)), end];
}

/** How a place compares: its address, and its spelling as an entry keeps it. */
interface PlaceKeys {
  readonly address: string;
  readonly spelling: string;
}

/**
 * For each action that stood on a known place, the first return to the
 * same address that followed a departure from it, with nothing typed,
 * chosen, or set on the way. Each wrong turn from one menu is a detour of
 * its own, so a replay that stops between two of them still has the first
 * whole (`findReplayedDetours`).
 *
 * A stored place (`DetourInput.stored`) has no record ids or query values
 * left to compare, so it is the same place as any other with its spelling.
 * Every other place compares by its address, a live `:id` in it included.
 */
function byLocations(trace: DetourInput): TraceDetour[] {
  const where = places(trace);
  // Each place read once: the scan compares every place with many others.
  const keys = new Map<string, PlaceKeys>();
  const keysOf = (place: string): PlaceKeys => {
    let read = keys.get(place);
    if (read === undefined) {
      read = { address: addressKey(place), spelling: routeLocation(place) };
      keys.set(place, read);
    }
    return read;
  };
  const stored = trace.stored ?? new Set<number>();
  const samePlace = (first: number, second: number): boolean => {
    const a = keysOf(where[first]!);
    const b = keysOf(where[second]!);
    return a.address === b.address || ((stored.has(first) || stored.has(second)) && a.spelling === b.spelling);
  };
  const { actions } = trace;
  const bounds = trace.bounds ?? [];
  const detours: TraceDetour[] = [];
  let from = 0;
  while (from < actions.length) {
    const settled = bounds.find((span) => span.from <= from && from < span.to);
    if (settled !== undefined) {
      from = settled.to;
      continue;
    }
    // A return at the start of the next settled span is the last one this trip may make.
    const limit = Math.min(actions.length, ...bounds.filter((span) => span.from > from).map((span) => span.from));
    const home = where[from];
    if (home === undefined) {
      from += 1;
      continue;
    }
    let via: string | undefined;
    let back: number | undefined;
    // The action that left: the last one known to stand home before the first departure.
    let left = from;
    for (let to = from + 1; to <= limit; to += 1) {
      if (changesState(actions[to - 1]!)) break;
      const place = where[to];
      if (place === undefined) continue;
      // Home is where the scan started and where the trip left from: a stored spelling matches both a record and another one.
      if (!samePlace(from, to) || !samePlace(left, to)) {
        via ??= place;
      } else if (via === undefined) {
        left = to;
      } else {
        back = to;
        break;
      }
    }
    if (back === undefined || via === undefined || trace.counts?.({ home: from, from: left, to: back }) === false) {
      from += 1;
      continue;
    }
    // Named by the place the leaving action stood on, as a stored span is (`recorded`), and spelled as an entry keeps it.
    detours.push({ from: left, to: back, at: routeLocation(where[left] ?? home), via: routeLocation(via), evidence: 'locations' });
    from = back;
  }
  return detours;
}

/** A tap or navigate, only looking after it, then `back`: an entry without locations, read by its actions. */
function byActions(actions: readonly RecordedAction[]): TraceDetour[] {
  const detours: TraceDetour[] = [];
  let from = 0;
  while (from < actions.length) {
    const leaving = actions[from]!;
    if (!LEAVING_ACTIONS.has(leaving.name) || changesState(leaving)) {
      from += 1;
      continue;
    }
    let next = from + 1;
    while (next < actions.length && LOOKING_ACTIONS.has(actions[next]!.name)) next += 1;
    if (actions[next]?.name !== 'back') {
      from += 1;
      continue;
    }
    detours.push({ from, to: next + 1, evidence: 'actions' });
    from = next + 1;
  }
  return detours;
}

/** Characters of `step.cache.detour` the report admits (report-1). */
const MAX_DETOUR_REPORT_CHARS = 600;

/**
 * A step's detour text within the report's bound, cut between two words so
 * no location is cut through: a stored location spells a space as `%20`,
 * and a value a later step resolves may be in it in a spelling the ledger
 * cannot read from a part of it (`settledDetour`). A text with no space
 * left in the bound is cut where the bound falls.
 */
export function boundDetour(text: string): string {
  if (text.length <= MAX_DETOUR_REPORT_CHARS) return text;
  const head = bound(text, MAX_DETOUR_REPORT_CHARS).slice(0, -1);
  const space = head.lastIndexOf(' ');
  return `${space === -1 ? head : head.slice(0, space)}…`;
}

/**
 * A step's detour text once its attempt settled, masked by the ledger as it
 * is then: a secret a later step resolved may be in a location the text
 * names. Where the report's bound cut the text it ends in an ellipsis, so a
 * value the cut went through is what ends before it (`redactCut`). Bounded
 * again after, since a marker can be longer than the value it replaced.
 */
export function settledDetour(detour: string, ledger: { readonly redact: (text: string) => string; readonly redactCut: (text: string) => string }): string {
  const masked = detour.endsWith('…') ? `${ledger.redactCut(detour.slice(0, -1))}…` : ledger.redact(detour);
  return boundDetour(masked);
}

/**
 * One detour as a line names it, actions numbered from 1 as the report
 * numbers them: `actions 2-4 left /settings for /settings/privacy and came
 * back with nothing typed, chosen, or set`, or `for another /orders/:id`
 * when the place it went to is spelled like the one it left (another record
 * of the route, other query values). That is all the rule can show:
 * a plain button tap on the way may still have saved something. A detour
 * read from an entry's actions alone says it is a hint wherever it is
 * printed, the step's report included, as `e2e cache check` reads it.
 */
export function describeDetour(detour: TraceDetour): string {
  // Every detour spans two actions at least: one that left, one that came back.
  const span = `actions ${String(detour.from + 1)}-${String(detour.to)}`;
  if (detour.evidence === 'actions') return `${span} left a screen, only looked around, and went back (recorded without locations: a hint only)`;
  // Another record of one route, or other query values, spell alike.
  const via = detour.via === undefined ? 'another' : detour.via === detour.at ? `another ${detour.via}` : detour.via;
  return `${span} left ${detour.at ?? 'a screen'} for ${via} and came back with nothing typed, chosen, or set`;
}
