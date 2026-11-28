/**
 * The file store's on-disk format: one test's recordings as two files.
 *
 * `<name>.yml` is the part a person reviews. It holds every recorded step of
 * one test, each under the instruction it was recorded for, then under each
 * target it was recorded on: what a replay does (`do`) and what it checks
 * before the step passes (`expect`). It is the replay input itself, not a
 * rendering of it: what reads back from it is what replays. It is reviewed,
 * not edited: each lock entry holds its recording to a digest of what the
 * YAML showed when it was written.
 *
 * `<name>.lock.json` is generated: the cache key of each recording, the
 * digests that key holds, the key's context, the provenance a replay never
 * reads (the executor, the model, its verdict), and the measured end wait,
 * which a replay gives its end checks (at most `MAX_TRACE_END_WAIT_MS`) and
 * no digest holds. A repository marks it `linguist-generated`, so a diff
 * folds it away; a lock change with no YAML change beside it is the one to
 * open.
 *
 * Reading never trusts the YAML more than an entry: the two files are
 * joined back into `trace-1` documents and validated by `readTraceEntry`,
 * the one owner of replayability. On top of that, the YAML is read with the
 * core schema only, refusing tags, anchors, aliases, merge keys, duplicate
 * keys, and any key the format does not name; and a lock entry replays
 * only the recording its digest names (`recordingDigest`), so neither an
 * edit nor a recording moved under another step's key replays. Nothing in
 * either file is evaluated.
 */

import type { Document, Node as YamlNode } from 'yaml';
import { summarizeRecordedAction } from '../agent/actions.ts';
import type { JsonValue } from '../types.ts';
import { canonicalJson, sha256Hex } from '../internal/ids.ts';
import { instructionDigest, paramsDigest } from './identity.ts';
import { readTestId } from './recording-name.ts';
import {
  DESCRIPTOR_FIELDS,
  isNodeAction,
  isNodeActionName,
  isTapActionName,
  TRACE_SCHEMA_VERSION,
  type ActionTrace,
  type RecordedAction,
  type TraceEntry,
  type TracePointEnd,
  type TraceProvenance,
  type TraceTargetDescriptor,
} from './trace.ts';
import { readTraceEntry } from './trace-read.ts';

/** The `format` every lock file this runner writes names, and the only one it reads. */
export const RECORDING_LOCK_FORMAT = 'e2e-replay-lock-1';

/** How every YAML this runner writes opens: its header comment's first words. */
const RECORDING_HEADER = '# Replay recording of one e2e test.';

/**
 * How every lock this runner writes opens: its `format`, the first field, matched as text so that a lock JSON
 * cannot parse (a merge conflict, whose markers come later) still shows it. A format named anywhere else in a
 * file is not this. Any version: a lock another `e2e` wrote in a format this one does not read is still the
 * store's own file.
 */
const LOCK_FORMAT_FIELD = /^\{\s*"format"\s*:\s*"e2e-replay-lock-\d+"/u;

/**
 * Whether a pair's files say this runner wrote them, from the start of each:
 * the YAML opens with the header comment, or the lock names the format. A
 * file with neither is someone else's, whatever its name, and the store
 * neither reads nor deletes it.
 */
export function writtenByStore(yamlHead: string | undefined, lockHead: string | undefined): boolean {
  return yamlHead?.startsWith(RECORDING_HEADER) === true || (lockHead !== undefined && LOCK_FORMAT_FIELD.test(lockHead));
}

/** The name every configured agent has unless a test names another; the YAML shows any other. */
const DEFAULT_AGENT = 'default';

/** The summary of a run-time value gap, as `TraceRecorder.recordDerivedGap` writes it. */
const DERIVED_GAP_SUMMARY = 'tool type (run-time value)';

/** Prefix of a project-tool gap's summary, as `TraceRecorder.recordGap` writes it; the rest is the tool's name. */
const TOOL_GAP_PREFIX = 'tool ';

/** One recording as the store holds it: its key, when it was recorded, and the trace. */
export interface StoredRecording {
  readonly keyHash: string;
  readonly createdAt: string;
  readonly trace: ActionTrace;
}

/** One test's recordings, in the order the YAML lists them. */
export interface RecordingFile {
  readonly testId: string;
  readonly recordings: readonly StoredRecording[];
}

type Yaml = typeof import('yaml');

/** The YAML library, loaded on first use: a CLI command that never opens a recording never pays for it. */
let yamlModule: Promise<Yaml> | undefined;

function loadYaml(): Promise<Yaml> {
  yamlModule ??= import('yaml');
  return yamlModule;
}

/** One recording read back: its validated entry, or why it cannot be trusted. */
export type ReadRecording =
  | { readonly keyHash: string; readonly status: 'hit'; readonly entry: TraceEntry }
  | { readonly keyHash: string; readonly status: 'invalid'; readonly reason: string };

/** A pair of files read back, or why the pair as a whole cannot be trusted. */
export type ParsedRecordingFile =
  | {
      readonly status: 'ok';
      readonly testId: string;
      /** Its recordings in the order the YAML lists them, then the ones that are not in it as written. */
      readonly recordings: readonly ReadRecording[];
      /** The YAML's recordings no lock entry claims (`steps[2] on web`): none of them replays. */
      readonly unclaimed: readonly string[];
    }
  | { readonly status: 'invalid'; readonly testId?: string; readonly keyHashes: readonly string[]; readonly reason: string };

/**
 * The step a recording belongs to within its test, whatever the target: the
 * same request (instruction and params), the same occurrence of it, by the
 * same agent. Recordings of one step on two targets sit side by side.
 */
export function stepIdentity(step: TraceProvenance | undefined): string | undefined {
  if (step?.paramsDigest === undefined || step.callIndex === undefined || step.agent === undefined) return undefined;
  return JSON.stringify([step.instructionDigest, step.paramsDigest, step.callIndex, step.agent, step.identityDigest ?? null]);
}

/** A test id as the YAML header names it: its file, and its titles joined the way a report joins them, a setup test's marked so. */
export function describeTestId(testId: string): { readonly test: string; readonly file?: string } {
  const { file, titles, setup } = readTestId(testId);
  if (file === undefined) return { test: testId };
  return { test: `${titles.join(' › ')}${setup ? ' (setup)' : ''}`, file };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** One step of the YAML: its recordings in the order they were first written. */
interface StepGroup {
  readonly identity: string;
  readonly recordings: StoredRecording[];
}

/** Groups recordings by step, steps in the order they first appear and targets within a step likewise. */
function groupSteps(recordings: readonly StoredRecording[]): StepGroup[] {
  const groups = new Map<string, StepGroup>();
  for (const recording of recordings) {
    const identity = stepIdentity(recording.trace.recordedFor)!;
    const group = groups.get(identity) ?? { identity, recordings: [] };
    group.recordings.push(recording);
    groups.set(identity, group);
  }
  return [...groups.values()];
}

/**
 * Renders one test's recordings as the YAML and lock pair, deterministically:
 * the same recordings always render to the same bytes, so a run that
 * recorded nothing new leaves a committed cache clean. Every recording must
 * name its whole step (`stepIdentity`) and the test's id.
 */
export async function renderRecordingFile(file: RecordingFile, lockName: string): Promise<{ readonly yaml: string; readonly lock: string }> {
  const yaml = await loadYaml();
  const doc = new yaml.Document();
  const flow = (value: object): YamlNode => doc.createNode(value, { flow: true }) as YamlNode;
  const header = describeTestId(file.testId);
  const groups = groupSteps(file.recordings);
  const placed: { readonly recording: StoredRecording; readonly step: number }[] = [];

  const steps = groups.map((group, stepIndex) => {
    const step = group.recordings[0]!.trace.recordedFor!;
    // A map, not an object: a target may be named `__proto__`.
    const targets = new Map<string, unknown>();
    for (const recording of group.recordings) {
      const { trace } = recording;
      targets.set(trace.recordedFor!.targetId, renderVariant(trace, flow));
      placed.push({ recording, step: stepIndex });
    }
    return {
      ...(step.instruction === undefined ? {} : { act: step.instruction }),
      ...(step.params === undefined ? {} : { params: step.params }),
      ...(step.agent === undefined || step.agent === DEFAULT_AGENT ? {} : { agent: step.agent }),
      // A test that runs one act more than once shows which run each block is, so two alike stay two.
      ...(step.callIndex === undefined || step.callIndex === 0 ? {} : { call: step.callIndex + 1 }),
      targets,
    };
  });

  doc.contents = doc.createNode({
    test: header.test,
    ...(header.file === undefined ? {} : { file: header.file }),
    steps,
  }) as typeof doc.contents;
  doc.commentBefore = [
    `${RECORDING_HEADER.slice(1)} Review it like code: each step lists what`,
    ' a replay does (do) and what it checks before the step passes (expect).',
    " Don't edit it: an edited recording no longer replays, and the test records",
    ' nothing until the edit is undone. To record a step again, delete it here.',
    ` Keys and digests: ${lockName}`,
  ].join('\n');
  spaceSteps(yaml, doc);
  quoteLineBreaks(yaml, doc);
  const text = doc.toString({ lineWidth: 0, indentSeq: true, blockQuote: false });

  // Each lock entry is held to its recording as the YAML reads back, so the digest is taken from the text itself.
  const written = (yaml.parse(text) as { steps: Record<string, unknown>[] }).steps;
  const entries = placed.map(({ recording, step }) => lockEntry(recording, recordingDigest(written[step]!, recording.trace.recordedFor!.targetId), groups[step]!));
  const lock = { format: RECORDING_LOCK_FORMAT, testId: file.testId, entries };
  return { yaml: text, lock: `${JSON.stringify(lock, null, 2)}\n` };
}

/**
 * Every string with a line break as a double-quoted scalar, its breaks
 * escaped. Plain, a break inside a flow mapping (`{ name: "Total:\n$42" }`)
 * renders as YAML the library itself refuses to read, and a block scalar
 * drops a line of only spaces (`" \n"` reads back as `"\n"`): a typed value
 * must read back as typed.
 */
function quoteLineBreaks(yaml: Yaml, doc: Document): void {
  yaml.visit(doc, {
    Scalar(_key, scalar) {
      if (typeof scalar.value === 'string' && /[\n\r]/u.test(scalar.value)) scalar.type = 'QUOTE_DOUBLE';
    },
  });
}

/** A blank line before `steps` and between steps, so each reads as its own block and a diff stays inside it. */
function spaceSteps(yaml: Yaml, doc: Document): void {
  yaml.visit(doc, {
    Pair(_key, pair, path) {
      if (path.length !== 2 || !yaml.isScalar(pair.key) || pair.key.value !== 'steps' || !yaml.isNode(pair.value)) return undefined;
      pair.key.spaceBefore = true;
      const items = (pair.value as { items?: unknown[] }).items ?? [];
      items.forEach((item, index) => {
        if (index > 0 && yaml.isNode(item)) item.spaceBefore = true;
      });
      return yaml.visit.SKIP;
    },
  });
}

/**
 * What a lock entry holds its recording to: the step as the YAML shows it
 * (act, params, agent), the target, and that target's recording, as the
 * YAML parses. An edit to any of them, a recording moved under another
 * step, or a YAML written without its lock no longer matches, wherever in
 * the file the step sits.
 */
function recordingDigest(step: Record<string, unknown>, targetId: string): string {
  const targets = step['targets'] as Record<string, unknown>;
  return sha256Hex(canonicalJson({
    act: step['act'] ?? null,
    params: step['params'] ?? null,
    agent: step['agent'] ?? null,
    // Only a repeated run shows `call`, so only then is it in the digest.
    ...(step['call'] === undefined ? {} : { call: step['call'] }),
    target: targetId,
    recording: Object.hasOwn(targets, targetId) ? targets[targetId] : null,
  }));
}

/**
 * The lock's line for one recording: everything a replay keys or never
 * reads, nothing a reviewer needs. It says when the act or params its step
 * shows do not digest to the ones its key holds (redacted, cut, or never
 * recorded); otherwise a reader holds them to the key, so a lock entry
 * pointed at another step's recording does not replay it. An entry that says
 * so is held by its digests alone: a lock edited to say it on purpose can
 * point a key at another step, which is why a lock change with no YAML
 * change is one to review (`docs/reference/security.mdx`).
 */
function lockEntry(recording: StoredRecording, digest: string, group: StepGroup): Record<string, unknown> {
  const { trace } = recording;
  const recordedFor = trace.recordedFor!;
  const shown = group.recordings[0]!.trace.recordedFor!;
  const actShown = shown.instruction !== undefined && instructionDigest(shown.instruction) === recordedFor.instructionDigest;
  const paramsShown = paramsDigest(shown.params) === recordedFor.paramsDigest;
  return {
    key: recording.keyHash,
    target: recordedFor.targetId,
    digest,
    createdAt: recording.createdAt,
    instructionDigest: recordedFor.instructionDigest,
    paramsDigest: recordedFor.paramsDigest,
    callIndex: recordedFor.callIndex,
    agent: recordedFor.agent,
    ...(recordedFor.identityDigest === undefined ? {} : { identityDigest: recordedFor.identityDigest }),
    ...(actShown ? {} : { actVerbatim: false }),
    ...(paramsShown ? {} : { paramsVerbatim: false }),
    executor: trace.executor,
    ...(trace.recordedBy === undefined ? {} : { recordedBy: trace.recordedBy }),
    summary: trace.summary,
    ...(trace.endWaitMs === undefined ? {} : { endWaitMs: trace.endWaitMs }),
    ...(trace.keyedBy === undefined ? {} : { keyedBy: trace.keyedBy }),
  };
}

/** One target's recording of a step: where it starts and ends, what it does, what it checks. */
function renderVariant(trace: ActionTrace, flow: (value: object) => YamlNode): Record<string, unknown> {
  const { startPath, endPath } = trace;
  const paths =
    startPath !== undefined && startPath === endPath
      ? { at: startPath }
      : { ...(startPath === undefined ? {} : { from: startPath }), ...(endPath === undefined ? {} : { to: endPath }) };
  const shows = trace.endAnchors ?? [];
  const gone = trace.goneAnchors ?? [];
  return {
    ...paths,
    do: trace.actions.map((action) => renderAction(action, flow)),
    ...(shows.length === 0 && gone.length === 0
      ? {}
      : {
          expect: {
            ...(shows.length === 0 ? {} : { shows: shows.map((anchor) => renderTarget(anchor, flow)) }),
            ...(gone.length === 0 ? {} : { gone: gone.map((anchor) => renderTarget(anchor, flow)) }),
          },
        }),
    ...(trace.truncated === true ? { truncated: true } : {}),
  };
}

/** A descriptor as one flow mapping, its fields in a fixed order. */
function renderTarget(target: TraceTargetDescriptor, flow: (value: object) => YamlNode): YamlNode {
  const fields: Record<string, unknown> = {};
  for (const field of DESCRIPTOR_FIELDS) {
    const value = target[field];
    if (value !== undefined) fields[field] = value;
  }
  if (target.states !== undefined) fields['states'] = [...target.states];
  if (target.position !== undefined) fields['position'] = { index: target.position.index, of: target.position.of };
  if (target.twinsWithoutTestId === true) fields['twinsWithoutTestId'] = true;
  if (target.countedOnEarlierLook === true) fields['countedOnEarlierLook'] = true;
  return flow(fields);
}

/** `1280x720`. */
function renderSize(size: { readonly width: number; readonly height: number }): string {
  return `${String(size.width)}x${String(size.height)}`;
}

function renderPointEnd(end: TracePointEnd, flow: (value: object) => YamlNode): YamlNode {
  return flow({
    x: end.point.x,
    y: end.point.y,
    ...(end.within === undefined ? {} : { on: renderTarget(end.within.target, flow), offset: [end.within.fx, end.within.fy] }),
  });
}

/**
 * One action in the YAML's words: the verb first, then what it needs. A
 * verb with nothing to say is a bare word (`back`); one with a target only
 * names it inline (`tap: { role: button, name: Save }`).
 */
function renderAction(action: RecordedAction, flow: (value: object) => YamlNode): unknown {
  const target = (descriptor: TraceTargetDescriptor) => renderTarget(descriptor, flow);
  if (isNodeAction(action)) {
    return { [action.name]: target(action.target), ...(action.modifiers === undefined ? {} : { hold: flow([...action.modifiers]) }) };
  }
  switch (action.name) {
    case 'type':
      return { type: action.value, into: target(action.target) };
    case 'typeText':
      return { type: action.value, ...(action.replace ? { replace: true } : {}) };
    case 'typeSecret':
      return { secret: action.secret, into: target(action.target) };
    case 'press':
      return { press: action.key, on: target(action.target) };
    case 'pressKey':
      return { press: action.key };
    case 'select':
      return { select: action.value, in: target(action.target) };
    case 'check':
      return { [action.checked ? 'check' : 'uncheck']: target(action.target) };
    case 'upload':
      return { upload: flow([...action.paths]), to: target(action.target) };
    case 'drag':
      return { drag: target(action.target), to: target(action.destination) };
    case 'scroll':
      return {
        scroll: action.direction,
        ...(action.target === undefined ? {} : { on: target(action.target) }),
        ...(action.times === undefined ? {} : { times: action.times }),
        ...(action.spans === undefined ? {} : { spans: action.spans }),
      };
    case 'scrollUntil':
      return {
        scroll: action.direction,
        until: action.text,
        ...(action.target === undefined ? {} : { on: target(action.target) }),
        ...(action.spans === undefined ? {} : { spans: action.spans }),
      };
    case 'navigate':
      return { navigate: action.url };
    case 'back':
      return 'back';
    case 'dismissKeyboard':
      return 'dismissKeyboard';
    case 'resize':
      return { resize: renderSize(action.size) };
    case 'switchTab':
      return { switchTab: action.tab };
    case 'closeTab':
      return { closeTab: action.tab };
    case 'tapAt':
    case 'hoverAt':
      return {
        [action.name]: flow({ x: action.point.x, y: action.point.y }),
        viewport: renderSize(action.viewport),
        ...(action.within === undefined ? {} : { on: target(action.within.target), offset: flow([action.within.fx, action.within.fy]) }),
      };
    case 'dragAt':
      return { dragAt: { from: renderPointEnd(action.from, flow), to: renderPointEnd(action.to, flow) }, viewport: renderSize(action.viewport) };
    case 'tool':
      return action.derived === undefined
        ? { tool: action.summary.startsWith(TOOL_GAP_PREFIX) ? action.summary.slice(TOOL_GAP_PREFIX.length) : action.summary }
        : { runtimeValue: action.derived };
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A reason a file pair cannot be read, with where in the YAML it went wrong when that is known. */
class RecordingFormatError extends Error {}

function fail(message: string): never {
  throw new RecordingFormatError(message);
}

/** Reads the YAML with the core schema only, refusing every construct that is not plain data. */
function parseYaml(yaml: Yaml, text: string): unknown {
  const doc = yaml.parseDocument(text, { schema: 'core', uniqueKeys: true, merge: false, strict: true, prettyErrors: true, version: '1.2' });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem !== undefined) fail(problem.message.split('\n')[0]!);
  yaml.visit(doc, {
    Node(_key, node) {
      if (yaml.isAlias(node)) fail(`an alias (*${node.source}) is not allowed${lineOf(node, text)}`);
      if (node.anchor !== undefined) fail(`an anchor (&${node.anchor}) is not allowed${lineOf(node, text)}`);
      if (node.tag !== undefined) fail(`a tag (${node.tag}) is not allowed${lineOf(node, text)}`);
      return undefined;
    },
  });
  return doc.toJS({ maxAliasCount: 0 });
}

/** ` at line N`, from a node's source range. */
function lineOf(node: YamlNode, text: string): string {
  const offset = node.range?.[0];
  if (offset === undefined) return '';
  return ` at line ${String(text.slice(0, offset).split('\n').length)}`;
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be a mapping`);
  return value as Record<string, unknown>;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be a list`);
  return value;
}

function readString(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where} must be a string`);
  return value;
}

/** Fails on any key outside `allowed`. */
function only(raw: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) fail(`${where} has an unknown key "${key}"`);
  }
}

const TARGET_KEYS: readonly string[] = [...DESCRIPTOR_FIELDS, 'states', 'position', 'twinsWithoutTestId', 'countedOnEarlierLook'];

/** A target as the YAML spells it, as `readTraceEntry` expects it; its fields are validated there. */
function readTarget(value: unknown, where: string): unknown {
  const raw = object(value, where);
  only(raw, TARGET_KEYS, where);
  return raw;
}

const SIZE = /^([1-9]\d{0,5})x([1-9]\d{0,5})$/u;

function readSize(value: unknown, where: string): { width: number; height: number } {
  const match = SIZE.exec(readString(value, where));
  if (match === null) fail(`${where} must read WIDTHxHEIGHT`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function readOffset(raw: Record<string, unknown>, where: string): unknown {
  if (raw['on'] === undefined && raw['offset'] === undefined) return undefined;
  if (raw['on'] === undefined || raw['offset'] === undefined) fail(`${where} needs both on and offset, or neither`);
  const offset = list(raw['offset'], `${where}.offset`);
  if (offset.length !== 2) fail(`${where}.offset must be [x, y]`);
  return { target: readTarget(raw['on'], `${where}.on`), fx: offset[0], fy: offset[1] };
}

function readPointEnd(value: unknown, where: string): unknown {
  const raw = object(value, where);
  only(raw, ['x', 'y', 'on', 'offset'], where);
  const within = readOffset(raw, where);
  return { point: { x: raw['x'], y: raw['y'] }, ...(within === undefined ? {} : { within }) };
}

/** Each verb's keys after the verb itself; the verb is always the first key. */
const VERB_KEYS: Readonly<Record<string, readonly string[]>> = {
  type: ['into', 'replace'],
  secret: ['into'],
  press: ['on'],
  select: ['in'],
  check: [],
  uncheck: [],
  upload: ['to'],
  drag: ['to'],
  scroll: ['on', 'times', 'spans', 'until'],
  navigate: [],
  resize: [],
  switchTab: [],
  closeTab: [],
  tapAt: ['viewport', 'on', 'offset'],
  hoverAt: ['viewport', 'on', 'offset'],
  dragAt: ['viewport'],
  tool: [],
  runtimeValue: [],
};

/** Placeholder summary until the action is validated; each is then rewritten from the action itself. */
const PENDING_SUMMARY = 'recorded action';

/**
 * One action of the YAML, as the raw `trace-1` action `readTraceEntry` takes.
 * Only the shape is checked here; every value is checked there.
 */
function readAction(value: unknown, where: string): Record<string, unknown> {
  if (value === 'back' || value === 'dismissKeyboard') return { name: value, summary: PENDING_SUMMARY };
  const raw = object(value, where);
  const verb = Object.keys(raw)[0];
  if (verb === undefined) fail(`${where} names no action`);
  const subject = raw[verb];
  const summary = PENDING_SUMMARY;
  if (isNodeActionName(verb)) {
    only(raw, [verb, ...(isTapActionName(verb) ? ['hold'] : [])], where);
    return { name: verb, summary, target: readTarget(subject, `${where}.${verb}`), ...(raw['hold'] === undefined ? {} : { modifiers: raw['hold'] }) };
  }
  // Own keys only: `constructor` or `toString` written as a verb is an unknown action, not an inherited one.
  const keys = Object.hasOwn(VERB_KEYS, verb) ? VERB_KEYS[verb] : undefined;
  if (keys === undefined) fail(`${where} has an unknown action "${verb}"`);
  only(raw, [verb, ...keys], where);
  const target = (key: string) => readTarget(raw[key], `${where}.${key}`);
  switch (verb) {
    case 'type':
      if (raw['into'] !== undefined) {
        if (raw['replace'] !== undefined) fail(`${where}: replace applies to the focused field, not to type ... into`);
        return { name: 'type', summary, value: subject, target: target('into') };
      }
      return { name: 'typeText', summary, value: subject, replace: raw['replace'] ?? false };
    case 'secret':
      return { name: 'typeSecret', summary, secret: subject, target: target('into') };
    case 'press':
      return raw['on'] === undefined ? { name: 'pressKey', summary, key: subject } : { name: 'press', summary, key: subject, target: target('on') };
    case 'select':
      return { name: 'select', summary, value: subject, target: target('in') };
    case 'check':
    case 'uncheck':
      return { name: 'check', summary, checked: verb === 'check', target: readTarget(subject, `${where}.${verb}`) };
    case 'upload':
      return { name: 'upload', summary, paths: subject, target: target('to') };
    case 'drag':
      return { name: 'drag', summary, target: readTarget(subject, `${where}.drag`), destination: target('to') };
    case 'scroll': {
      const on = raw['on'] === undefined ? {} : { target: target('on') };
      const spans = raw['spans'] === undefined ? {} : { spans: raw['spans'] };
      if (raw['until'] !== undefined) {
        if (raw['times'] !== undefined) fail(`${where}: times does not apply to scroll ... until`);
        return { name: 'scrollUntil', summary, direction: subject, text: raw['until'], ...on, ...spans };
      }
      return { name: 'scroll', summary, direction: subject, ...on, ...(raw['times'] === undefined ? {} : { times: raw['times'] }), ...spans };
    }
    case 'navigate':
      return { name: 'navigate', summary, url: subject };
    case 'resize':
      return { name: 'resize', summary, size: readSize(subject, `${where}.resize`) };
    case 'switchTab':
    case 'closeTab':
      return { name: verb, summary, tab: subject };
    case 'tapAt':
    case 'hoverAt': {
      const point = object(subject, `${where}.${verb}`);
      only(point, ['x', 'y'], `${where}.${verb}`);
      const within = readOffset(raw, where);
      return { name: verb, summary, point, viewport: readSize(raw['viewport'], `${where}.viewport`), ...(within === undefined ? {} : { within }) };
    }
    case 'dragAt': {
      const ends = object(subject, `${where}.dragAt`);
      only(ends, ['from', 'to'], `${where}.dragAt`);
      return {
        name: 'dragAt',
        summary,
        from: readPointEnd(ends['from'], `${where}.dragAt.from`),
        to: readPointEnd(ends['to'], `${where}.dragAt.to`),
        viewport: readSize(raw['viewport'], `${where}.viewport`),
      };
    }
    case 'tool':
      return { name: 'tool', summary: `${TOOL_GAP_PREFIX}${readString(subject, `${where}.tool`)}` };
    case 'runtimeValue':
      return { name: 'tool', summary: DERIVED_GAP_SUMMARY, derived: subject };
    default:
      return fail(`${where} has an unknown action "${verb}"`);
  }
}

/** The fields of one target's recording of a step, as the raw `trace-1` payload fields they become. */
function readVariant(value: unknown, where: string): Record<string, unknown> {
  const raw = object(value, where);
  only(raw, ['at', 'from', 'to', 'do', 'expect', 'truncated'], where);
  if (raw['at'] !== undefined && (raw['from'] !== undefined || raw['to'] !== undefined)) fail(`${where} has at and from or to; at means both`);
  const actions = list(raw['do'], `${where}.do`).map((action, index) => readAction(action, `${where}.do[${String(index)}]`));
  const expectRaw = raw['expect'] === undefined ? {} : object(raw['expect'], `${where}.expect`);
  only(expectRaw, ['shows', 'gone'], `${where}.expect`);
  const anchors = (key: 'shows' | 'gone') =>
    expectRaw[key] === undefined ? undefined : list(expectRaw[key], `${where}.expect.${key}`).map((anchor, index) => readTarget(anchor, `${where}.expect.${key}[${String(index)}]`));
  const shows = anchors('shows');
  const gone = anchors('gone');
  if (raw['truncated'] !== undefined && raw['truncated'] !== true) fail(`${where}.truncated must be true when present`);
  return {
    actions,
    ...(raw['at'] !== undefined ? { startPath: raw['at'], endPath: raw['at'] } : {}),
    ...(raw['from'] === undefined ? {} : { startPath: raw['from'] }),
    ...(raw['to'] === undefined ? {} : { endPath: raw['to'] }),
    ...(shows === undefined ? {} : { endAnchors: shows }),
    ...(gone === undefined ? {} : { goneAnchors: gone }),
    ...(raw['truncated'] === true ? { truncated: true } : {}),
  };
}

interface ReadStep {
  readonly act?: string;
  readonly params?: Readonly<Record<string, JsonValue>>;
  readonly agent?: string;
  /** Which run of its act in the test this step is, from 2; absent on the first. */
  readonly call?: number;
  /** Each target's recording, as `trace-1` payload fields, and its `recordingDigest`. */
  readonly targets: ReadonlyMap<string, { readonly variant: Record<string, unknown>; readonly digest: string }>;
}

function readSteps(document: unknown): { readonly test: string; readonly file?: string; readonly steps: readonly ReadStep[] } {
  const raw = object(document, 'the recording');
  only(raw, ['test', 'file', 'steps'], 'the recording');
  const test = readString(raw['test'], 'test');
  const file = raw['file'] === undefined ? undefined : readString(raw['file'], 'file');
  // Deleting a file's last step leaves a bare `steps:`, which YAML reads as null: the same as `steps: []`.
  const steps = list(raw['steps'] === null ? [] : raw['steps'], 'steps').map((value, index): ReadStep => {
    const where = `steps[${String(index)}]`;
    const step = object(value, where);
    only(step, ['act', 'params', 'agent', 'call', 'targets'], where);
    const act = step['act'] === undefined ? undefined : readString(step['act'], `${where}.act`);
    const params = step['params'] === undefined ? undefined : (object(step['params'], `${where}.params`) as Readonly<Record<string, JsonValue>>);
    const agent = step['agent'] === undefined ? undefined : readString(step['agent'], `${where}.agent`);
    const call = step['call'];
    if (call !== undefined && (typeof call !== 'number' || !Number.isSafeInteger(call) || call < 2)) fail(`${where}.call must be a whole number from 2`);
    // Deleting a step's last target leaves a bare `targets:`, null, or `{}`: a step with nothing recorded, as if deleted.
    const targetsRaw = object(step['targets'] === null ? {} : step['targets'], `${where}.targets`);
    const targets = new Map(
      Object.entries(targetsRaw).map(([targetId, variant]) => [
        targetId,
        { variant: readVariant(variant, `${where}.targets.${targetId}`), digest: recordingDigest(step, targetId) },
      ]),
    );
    return {
      ...(act === undefined ? {} : { act }),
      ...(params === undefined ? {} : { params }),
      ...(agent === undefined ? {} : { agent }),
      ...(call === undefined ? {} : { call }),
      targets,
    };
  });
  return { test, ...(file === undefined ? {} : { file }), steps };
}

const SHA256_HEX = /^[a-f0-9]{64}$/u;

interface LockEntry {
  readonly key: string;
  readonly target: string;
  readonly digest: string;
  readonly raw: Record<string, unknown>;
}

function readLock(text: string): { readonly testId: string; readonly entries: readonly LockEntry[] } {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    fail(`the lock file is not JSON: ${(cause as Error).message}`);
  }
  const raw = object(document, 'the lock file');
  if (raw['format'] !== RECORDING_LOCK_FORMAT) fail(`the lock file's format is not ${RECORDING_LOCK_FORMAT}`);
  const testId = raw['testId'];
  if (typeof testId !== 'string' || testId === '') fail("the lock file's testId must be a string");
  const seen = new Set<string>();
  const entries = list(raw['entries'], "the lock file's entries").map((value, index): LockEntry => {
    const entry = object(value, `lock entry ${String(index)}`);
    const { key, target, digest } = entry;
    if (typeof key !== 'string' || !SHA256_HEX.test(key)) fail(`lock entry ${String(index)} has no key`);
    if (typeof target !== 'string' || target === '') fail(`lock entry ${String(index)} has no target`);
    if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) fail(`lock entry ${String(index)} has no digest`);
    if (seen.has(key)) fail(`lock entry ${String(index)} repeats a key`);
    seen.add(key);
    return { key, target, digest, raw: entry };
  });
  return { testId, entries };
}

/**
 * Reads a YAML and lock pair back into validated entries. Each lock entry
 * finds its recording in the YAML by its digest, wherever the step sits, so
 * steps reordered, merged in, or deleted leave the others readable. A pair
 * whose YAML is not in the format is invalid as a whole; a recording whose
 * fields do not validate is invalid alone.
 *
 * A lock entry whose recording is not in the YAML was deleted from it, and
 * reads as absent, unless the YAML also holds a recording no entry claims:
 * then a recording was edited (or the YAML written without its lock), and
 * every entry left without one is invalid. A claimed recording never
 * replays under a key it was not written for.
 */
export async function parseRecordingFile(yamlText: string, lockText: string): Promise<ParsedRecordingFile> {
  let lock: ReturnType<typeof readLock>;
  try {
    lock = readLock(lockText);
  } catch (cause) {
    return { status: 'invalid', keyHashes: [], reason: errorText(cause) };
  }
  const keyHashes = lock.entries.map((entry) => entry.key);
  let read: ReturnType<typeof readSteps>;
  try {
    read = readSteps(parseYaml(await loadYaml(), yamlText));
    const header = describeTestId(lock.testId);
    if (read.test !== header.test || read.file !== header.file) fail(`the test it names is not the lock file's ${lock.testId}`);
  } catch (cause) {
    return { status: 'invalid', testId: lock.testId, keyHashes, reason: errorText(cause) };
  }
  // Every recording the YAML shows, by digest; each lock entry claims one, so one block never answers two keys.
  interface Shown {
    readonly index: number;
    readonly targetId: string;
    readonly step: ReadStep;
    readonly variant: Record<string, unknown>;
    claimed: boolean;
  }
  const shown = new Map<string, Shown[]>();
  read.steps.forEach((step, index) => {
    for (const [targetId, { variant, digest }] of step.targets) {
      shown.set(digest, [...(shown.get(digest) ?? []), { index, targetId, step, variant, claimed: false }]);
    }
  });
  const found: { readonly order: number; readonly recording: ReadRecording }[] = [];
  const unmatched: LockEntry[] = [];
  for (const entry of lock.entries) {
    const match = shown.get(entry.digest)?.find((candidate) => !candidate.claimed && candidate.targetId === entry.target);
    if (match === undefined) {
      unmatched.push(entry);
      continue;
    }
    match.claimed = true;
    found.push({ order: match.index, recording: readRecording(lock.testId, entry, match.index, match.step, match.variant) });
  }
  const unclaimed = [...shown.values()]
    .flat()
    .filter((candidate) => !candidate.claimed)
    .toSorted((a, b) => a.index - b.index)
    .map((candidate) => `steps[${String(candidate.index)}] on ${candidate.targetId}`);
  const edited = unclaimed.length === 0
    ? []
    : unmatched.map((entry): ReadRecording => ({
        keyHash: entry.key,
        status: 'invalid',
        reason: `the recording of key ${entry.key.slice(0, 12)} on ${entry.target} is not in the YAML as it was written: edited, or written without its lock`,
      }));
  return {
    status: 'ok',
    testId: lock.testId,
    recordings: [...found.toSorted((a, b) => a.order - b.order).map((item) => item.recording), ...edited],
    unclaimed,
  };
}

/**
 * The lock with `keyHash`'s entries dropped and the rest as they were, in
 * the form `renderRecordingFile` writes: how a key is evicted from a pair
 * whose YAML cannot be rewritten. Its YAML block, no longer claimed, never
 * replays. Throws when the lock does not read.
 */
export function lockWithout(lockText: string, keyHash: string): string {
  const { testId, entries } = readLock(lockText);
  const lock = { format: RECORDING_LOCK_FORMAT, testId, entries: entries.filter((entry) => entry.key !== keyHash).map((entry) => entry.raw) };
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/**
 * A lock whose YAML is gone: nothing anyone reviewed is left, so the pair
 * holds no recordings, as a YAML with every step deleted holds none, and a
 * write may replace it. Invalid when the lock itself does not read.
 */
export function parseLockAlone(lockText: string): ParsedRecordingFile {
  try {
    return { status: 'ok', testId: readLock(lockText).testId, recordings: [], unclaimed: [] };
  } catch (cause) {
    return { status: 'invalid', keyHashes: [], reason: errorText(cause) };
  }
}

/**
 * Whether a YAML is the named test's, by its `test` and `file`: for a pair
 * whose lock cannot say whose it is. Undefined when the YAML does not read
 * far enough to tell.
 */
export async function recordingNamesTest(yamlText: string, testId: string): Promise<boolean | undefined> {
  const yaml = await loadYaml();
  let document: unknown;
  try {
    document = yaml.parse(yamlText);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null) return undefined;
  const { test, file } = document as { test?: unknown; file?: unknown };
  if (typeof test !== 'string') return undefined;
  const header = describeTestId(testId);
  return test === header.test && (file ?? undefined) === header.file;
}

function errorText(cause: unknown): string {
  if (cause instanceof RecordingFormatError) return cause.message;
  // A YAML too deeply nested to read overflows the parser's stack.
  if (cause instanceof RangeError) return 'the recording nests too deeply to read';
  return cause instanceof Error ? cause.message : String(cause);
}

/** One recording joined from its lock entry and its YAML, validated as a `trace-1` entry. */
function readRecording(testId: string, entry: LockEntry, index: number, step: ReadStep, variant: Record<string, unknown>): ReadRecording {
  const invalid = (reason: string): ReadRecording => ({ keyHash: entry.key, status: 'invalid', reason });
  const lock = entry.raw;
  const where = `steps[${String(index)}] on ${entry.target}`;
  if ((step.agent ?? DEFAULT_AGENT) !== lock['agent']) return invalid(`${where} names another agent than its lock entry`);
  // The digest holds the YAML to the lock entry; these hold the lock entry to its key's step, so a lock merged
  // by hand that points one key at another step's recording does not replay it. An entry that says its act or
  // params are not verbatim skips that check, so one edited to say so on purpose can (see `lockEntry`).
  if (lock['actVerbatim'] !== false && (step.act === undefined || instructionDigest(step.act) !== lock['instructionDigest'])) {
    return invalid(`${where}: its act is not the instruction its key was recorded for`);
  }
  if (lock['paramsVerbatim'] !== false && paramsDigest(step.params) !== lock['paramsDigest']) {
    return invalid(`${where}: its params are not the ones its key was recorded for`);
  }
  if ((step.call ?? 1) - 1 !== lock['callIndex']) return invalid(`${where}: its call is not the run of the act its key was recorded for`);
  const recordedFor = {
    testId,
    targetId: entry.target,
    instructionDigest: lock['instructionDigest'],
    paramsDigest: lock['paramsDigest'],
    callIndex: lock['callIndex'],
    agent: lock['agent'],
    ...(lock['identityDigest'] === undefined ? {} : { identityDigest: lock['identityDigest'] }),
    ...(step.act === undefined ? {} : { instruction: step.act }),
    ...(step.params === undefined ? {} : { params: step.params }),
  };
  const document = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    createdAt: lock['createdAt'],
    payload: {
      ...variant,
      executor: lock['executor'],
      recordedFor,
      ...(lock['recordedBy'] === undefined ? {} : { recordedBy: lock['recordedBy'] }),
      summary: lock['summary'],
      ...(lock['endWaitMs'] === undefined ? {} : { endWaitMs: lock['endWaitMs'] }),
      ...(lock['keyedBy'] === undefined ? {} : { keyedBy: lock['keyedBy'] }),
    },
  };
  const read = readTraceEntry(document);
  if (read === undefined) return invalid(`${where} is not a replayable recording`);
  if (read.payload.recordedFor?.callIndex === undefined || read.payload.recordedFor.paramsDigest === undefined || read.payload.recordedFor.agent === undefined) {
    return invalid(`${where} does not name its whole step`);
  }
  const actions = read.payload.actions.map((action) => (action.name === 'tool' ? action : { ...action, summary: summarizeRecordedAction(action) }));
  return { keyHash: entry.key, status: 'hit', entry: { ...read, payload: { ...read.payload, actions } } };
}
