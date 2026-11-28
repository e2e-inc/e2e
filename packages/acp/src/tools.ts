/**
 * The tools a session offers: the built-in agent's action tools
 * (`createGrammarTools` from `e2e/agent`) and its `complete_step`
 * (`createVerdictTool`). An ACP session lists its tools once, while e2e
 * builds them per step, so the session lists them from its first step and
 * each call runs the active step's own tool of that name. Every action goes
 * through `ctx.actions`, where the runner authorizes, counts, and records
 * it, so steps replay from the cache as the built-in agent's do.
 */

import type { ExecutorExtension, StepExecutorContext, StepVerdict } from 'e2e';
import { createGrammarTools, createProjectTools, createVerdictTool, isRuntimeHardStop, redactSecrets, redactStepText, type ScreenOutput, type VerdictTool } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import type { z } from 'zod';
import type { ServedTool, ToolResult } from './mcp.ts';
import { encodeImage, message } from './turns.ts';

/** One tool as `e2e/agent` builds it: an AI SDK tool. */
interface SdkTool {
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly execute?: (input: unknown, options: { toolCallId: string; messages: [] }) => unknown;
}
type SdkTools = Readonly<Record<string, SdkTool>>;

/** Tools from `defineTool` a session offers beside the action tools, by name. */
export type ExtraTools = NonNullable<ExecutorExtension['tools']>;

/** The step a session serves now. */
export interface ActiveStep {
  readonly ctx: StepExecutorContext;
  /** The step's `complete_step`, which holds its verdict once the agent concludes. */
  readonly conclusion: VerdictTool;
  /** A runtime error a tool hit; the turn is cancelled and `runStep` rethrows it. */
  halted: unknown;
  /** A tool of the agent's own that ran without asking; the turn is cancelled and the step fails. */
  denied: string | undefined;
  /** Tool names in call order, for the transcript. */
  readonly calls: string[];
  /** The step's own action tools and the extra ones it offers; its screens report changes against the one before. */
  readonly tools: SdkTools;
}

/** The step a session starts serving, with nothing concluded yet. */
export function activeStep(ctx: StepExecutorContext, extra: ExtraTools): ActiveStep {
  const active: ActiveStep = {
    ctx,
    conclusion: createVerdictTool(ctx.step.kind),
    halted: undefined,
    denied: undefined,
    calls: [],
    tools: {
      ...(createProjectTools(ctx, extra) as SdkTools),
      // The guard runs when a call's turn in the queue comes, so a call batched behind the verdict or a stop is skipped.
      ...(createGrammarTools(ctx, { guard: (body) => (stopped(active) ? Promise.resolve(STEP_ENDED) : body()) }) as SdkTools),
    },
  };
  return active;
}

/** The verdict the agent concluded the step with, if it did. */
export function verdictOf(active: ActiveStep): StepVerdict | undefined {
  return active.conclusion.verdict();
}

/** Where the tools find the active step, and how a tool ends the turn early. */
export interface StepSlot {
  active: ActiveStep | undefined;
  /** Called when a tool hit a runtime error: cancels the agent's turn. */
  halt(): void;
}

/** Whether the step takes no more actions: concluded, halted by a runtime error, or stopped for a tool of the agent's own. */
function stopped(active: ActiveStep): boolean {
  return active.conclusion.concluded() || active.halted !== undefined || active.denied !== undefined;
}

const STEP_ENDED = 'The step has ended. Wait for the next instruction.';

/** Runs one tool and returns what it answered. */
async function run(tools: SdkTools, name: string, input: unknown): Promise<unknown> {
  const tool = tools[name];
  if (tool?.execute === undefined) throw new Error(unavailable(name));
  return tool.execute(input, { toolCallId: name, messages: [] });
}

/** Runs one action tool or `complete_step`, which answer a screen. */
async function runAction(tools: SdkTools, name: string, input: unknown): Promise<ScreenOutput> {
  return (await run(tools, name, input)) as ScreenOutput;
}

/** The step's first screen, whole: the first look of its action tools, which later results report changes against. */
export async function openingScreen(active: ActiveStep): Promise<string> {
  const output = await runAction(active.tools, 'observe', {});
  return typeof output === 'string' ? output : output.text;
}

/** The listed tools the active step does not offer, by the reason it would give. */
export function missingTools(active: ActiveStep, listed: readonly ServedTool[]): string[] {
  return listed.filter((tool) => tool.name !== 'complete_step' && active.tools[tool.name] === undefined).map((tool) => `${tool.name} (${unavailable(tool.name)})`);
}

/** The session's tools, listed from its first step. */
export function stepTools(slot: StepSlot, first: StepExecutorContext, extra: ExtraTools): ServedTool[] {
  const current = (name: string): ActiveStep => {
    const active = slot.active;
    if (active === undefined || stopped(active)) {
      throw new Error('No step is active. Wait for the next instruction.');
    }
    active.calls.push(name);
    return active;
  };
  /** Runs a tool body against the active step; a runtime error ends the turn, anything else goes back to the agent as the call's error. */
  const guarded = async (name: string, body: (active: ActiveStep) => Promise<ToolResult>): Promise<ToolResult> => {
    let active: ActiveStep | undefined;
    try {
      active = current(name);
      return await body(active);
    } catch (error) {
      if (active !== undefined && isRuntimeHardStop(error)) {
        active.halted = error;
        slot.halt();
        return { text: `The step has ended (${error.code}). Stop and wait for the next instruction.`, isError: true };
      }
      // Redacted whole, before the first line is taken: an extension's tool is the project's code, and its error may quote a secret.
      const said = active === undefined ? redactSecrets(message(error)) : redactStepText(active.ctx, message(error));
      return { text: `${name} failed: ${said.split('\n')[0] ?? ''}`, isError: true };
    }
  };
  const serve = (name: string, tool: SdkTool, readOnly: boolean, answer: (active: ActiveStep, args: unknown) => Promise<ToolResult>): ServedTool => ({
    name,
    description: name === 'type_secret' ? TYPE_SECRET : (tool.description ?? name),
    inputSchema: tool.inputSchema as z.ZodObject,
    readOnly,
    run: (args) =>
      guarded(name, async (active) => {
        if (!readOnly && active.ctx.step.kind === 'assert') {
          throw new Error('this step is an assertion: read the screen and conclude, do not change it');
        }
        return answer(active, args);
      }),
  });
  const widest = widestStep(first);
  const assertionContext = Object.create(first, { step: { value: { ...first.step, kind: 'assert' } } }) as StepExecutorContext;
  const readOnlyTools = createGrammarTools(assertionContext);
  const actions = createGrammarTools(widest) as SdkTools;
  const tools = Object.entries(actions).map(([name, tool]) =>
    serve(name, tool, name in readOnlyTools, async (active, args) => screen(await runAction(active.tools, name, args))),
  );
  const offered = createProjectTools(widest, extra) as SdkTools;
  for (const [name, defined] of Object.entries(extra)) {
    const tool = offered[name];
    // Scoped to another platform: no step of this attempt gets it.
    if (tool === undefined) continue;
    if (name in actions || name === 'complete_step') {
      throw new ConfigurationError('INVALID_CONFIG', `the ${name} tool name is reserved for the agent's own tools: an extension cannot take it`);
    }
    if (!isStandardSchema(tool.inputSchema)) {
      throw new ConfigurationError('INVALID_CONFIG', `the ${name} tool has no schema an MCP server can list: give it a Zod inputSchema`);
    }
    tools.push(serve(name, tool, !defined.annotations.mutates, async (active, args) => plain(await run(active.tools, name, args))));
  }
  const conclusion = createVerdictTool().tool as SdkTool;
  tools.push({
    name: 'complete_step',
    description: conclusion.description ?? 'complete_step',
    inputSchema: conclusion.inputSchema as z.ZodObject,
    readOnly: true,
    run: (args) =>
      guarded('complete_step', async (active) => {
        const answer = await runAction({ complete_step: active.conclusion.tool as SdkTool }, 'complete_step', args);
        const text = typeof answer === 'string' ? answer : answer.text;
        return { text: active.conclusion.concluded() ? `${text} Wait for the next instruction.` : text };
      }),
  });
  return tools;
}

/** Listed in place of the grammar's own description, which names one step's secrets. */
const TYPE_SECRET =
  'Fill one declared secret into an input by its name; the plaintext never passes through you. A password fills only a password field; a generic-secret fills any editable input. The step message lists the secrets it declares.';

/**
 * The first step as the one with the most tools any step of the attempt can
 * get: an action, with a secret, since `type_secret` is built only for a step
 * that declares one. A call of a tool the active step lacks says why.
 */
function widestStep(first: StepExecutorContext): StepExecutorContext {
  return Object.create(first, {
    step: { value: { ...first.step, kind: 'act', secrets: [{ name: 'secret', purpose: 'password' }] } },
  }) as StepExecutorContext;
}

function unavailable(name: string): string {
  if (name === 'type_secret') return 'this step declares no secrets';
  return `${name} is not available in this step`;
}

/** A rendered screen as an MCP result: its text, with the screenshot as an image when it carries one. */
function screen(output: ScreenOutput): ToolResult {
  return typeof output === 'string' ? { text: output } : { text: output.text, image: encodeImage(output.pixels) };
}

/** What an extra tool returned as an MCP result: text as it is, anything else as JSON. */
function plain(output: unknown): ToolResult {
  return { text: typeof output === 'string' ? output : (JSON.stringify(output) ?? '') };
}

function isStandardSchema(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && '~standard' in schema;
}
