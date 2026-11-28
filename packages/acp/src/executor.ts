import { randomUUID } from 'node:crypto';
import { AgentError, type ExecutorExtension, type JsonValue, type StepExecutor, type StepExecutorContext, type StepVerdict } from 'e2e';
import { BASE_RULES, redactSecrets, redactStepText, registerProviderKeys, VERDICT_RULES } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import { claudeCodeLaunch, codexLaunch, registerSavedCodexLogin } from './presets.ts';
import { holdSession, type HeldSession } from './held.ts';
import type { AcpSession, AgentLaunch, TurnReport } from './session.ts';
import { activeStep, missingTools, openingScreen, stepTools, verdictOf, type ActiveStep, type ExtraTools, type StepSlot } from './tools.ts';
import type { ServedTool } from './mcp.ts';
import type { AcpAgentOptions, AcpOptions } from './types.ts';
import { createAnswer } from './judgment.ts';
import { message, turnUsage, untilAborted } from './turns.ts';

/** What the session is, before the built-in agent's rules for the same tools. */
const SESSION_RULES = `This conversation drives a real application for an end-to-end test, one step per message: an action to perform, or an assertion to judge, with the current screen.
Use only the tools of this conversation. You have no access to the application's source, files, shell, or network.
The rules below are for each step. A step ends when you call complete_step; then wait for the next message. For an assertion, judge the condition from the screen without changing anything.`;

const RULES = `${SESSION_RULES}\n\n${BASE_RULES}\n\n${VERDICT_RULES}`;

/** How long a step waits for the turn of a step the runner gave up on to stop. */
const LAST_TURN_GRACE_MS = 5_000;

/** What an attempt keeps for its steps. */
interface Held {
  readonly agent: HeldSession;
  readonly slot: StepSlot;
  /** The tools the session lists, fixed for the attempt. */
  readonly tools: readonly ServedTool[];
  /** The turn in flight, settled or not: one the runner gave up on may still be running. */
  turn: Promise<unknown> | undefined;
}

/**
 * Runs agent steps on any agent that speaks ACP on stdio: one agent session
 * per test attempt for `agent.act` and `agent.assert`, started by its first
 * agent step and closed when the attempt ends, and one more for
 * `agent.waitFor` and `agent.extract` (`judgment.ts`). `claudeCode()` and `codex()` start those
 * agents with the step tools as their only tools.
 */
export function acp(options: AcpOptions): StepExecutor {
  if (typeof options !== 'object' || options === null || typeof options.command !== 'string' || options.command === '') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "acp() takes { command, args }, e.g. acp({ command: 'agent', args: ['acp'] }), or use claudeCode() or codex()",
    );
  }
  const launch: AgentLaunch = {
    command: options.command,
    args: options.args ?? [],
    env: options.env,
    model: options.model,
    mode: options.mode,
    sessionMeta: options.sessionMeta,
  };
  return executor(options.name ?? 'acp', options, { launch: async () => launch, registerLogin: NO_LOGIN, extra: {} });
}

/** Claude Code through Zed's adapter (`@agentclientprotocol/claude-agent-acp`), signed in with your `claude` login. */
export function claudeCode(options: AcpAgentOptions = {}): StepExecutor {
  return executor(options.name ?? 'claude-code', options, { launch: claudeCodeLaunch(options), registerLogin: NO_LOGIN, extra: {} });
}

/** Codex through its adapter (`@agentclientprotocol/codex-acp`), signed in with your `codex` login, or with `OPENAI_API_KEY` when Codex has none. */
export function codex(options: AcpAgentOptions = {}): StepExecutor {
  return executor(options.name ?? 'codex', options, { launch: codexLaunch(options), registerLogin: () => registerSavedCodexLogin(options.env), extra: {} });
}

/** How one executor starts its agent, and what it adds to the agent's session. */
interface Agent {
  readonly launch: () => Promise<AgentLaunch>;
  /**
   * Has the run redact the login the agent keeps on disk. It runs once when
   * the executor is built, for a login saved before the run, then for each
   * step once the agent is up, since the agent renews a login between turns,
   * and again once the turn is over, before anything the agent said in it is
   * returned.
   */
  readonly registerLogin: () => void;
  /** The tools an extension offers beside the step tools. */
  readonly extra: ExtraTools;
}

const NO_LOGIN = (): void => undefined;

function executor(name: string, options: AcpAgentOptions, agent: Agent): StepExecutor {
  const { launch, registerLogin, extra } = agent;
  // A key only the agent's own `env` holds, known before the first step's text is built.
  registerProviderKeys(options.env ?? {});
  // A login the agent saved before this run, known before its first start: that start's stderr or the first step's text may quote it.
  registerLogin();
  // Where an attempt's session lives in `attempt.memory`: one key per executor, so two ACP agents never share a session.
  const memoryKey = `@e2e-dev/acp.session.${randomUUID()}`;
  return {
    name,
    version: '1',
    cache: 'inherit',
    async runStep(ctx) {
      // The login the agent's start wrote is registered by now, before any of the step's text is built.
      const { held, session } = await ready(ctx, agent, memoryKey);
      ctx.signal.throwIfAborted();
      const active = activeStep(ctx, extra);
      // With the step's own redactor, and only now: `system` is the config's text, which core never saw, and a key the agent's start or its saved login made known may be in step text core built before it knew the key.
      const text = redactStepText(ctx, await untilAborted(stepMessage(active, held.tools, held.agent.introduced ? undefined : [RULES, options.system, ctx.agentContext]), ctx.signal));
      // A step that ended while its screen was read sends no prompt, which no cancel would reach.
      ctx.signal.throwIfAborted();
      held.agent.introduced = true;
      held.slot.active = active;
      const cancel = () => session.cancel();
      ctx.signal.addEventListener('abort', cancel, { once: true });
      let report: TurnReport;
      try {
        const turn = session.prompt(text);
        held.turn = turn;
        report = await untilAborted(turn, ctx.signal);
      } catch (error) {
        ctx.signal.throwIfAborted();
        held.agent.close();
        throw new AgentError('MODEL_PROVIDER_FAILED', `The ACP agent session failed: ${message(error)}`, { cause: error });
      } finally {
        if (held.slot.active === active) held.slot.active = undefined;
        ctx.signal.removeEventListener('abort', cancel);
        registerLogin();
      }
      ctx.attachTranscript(transcript(text, active, report));
      if (!ctx.signal.aborted) ctx.budgets.recordModelCall(turnUsage(session, report));
      if (active.halted !== undefined) throw active.halted;
      ctx.signal.throwIfAborted();
      if (active.denied !== undefined) {
        // The conversation holds what the tool read: the next step starts a fresh agent.
        held.agent.close();
        return ownToolUsed(active.denied);
      }
      return verdictOf(active) ?? noConclusion(report);
    },
    answer: createAnswer(launch, registerLogin),
    extend: (extension: ExecutorExtension) =>
      executor(name, withSystem(options, extension.system), { ...agent, extra: { ...extra, ...extension.tools } }),
  };
}

/** The attempt's session once the turn of the step before it stopped, or a fresh one when that turn's end closed it. */
async function ready(ctx: StepExecutorContext, agent: Agent, memoryKey: string): Promise<{ held: Held; session: AcpSession }> {
  const held = hold(ctx, agent, memoryKey);
  const session = await held.agent.started(ctx.signal);
  if (!(await settled(held.turn, LAST_TURN_GRACE_MS, ctx.signal))) {
    held.agent.close();
    throw new AgentError('MODEL_PROVIDER_FAILED', 'The ACP agent did not stop the turn of a step that already ended');
  }
  // A tool of the agent's own that ran as that turn stopped closed the session.
  if (held.agent.closed) return ready(ctx, agent, memoryKey);
  return { held, session };
}

/** The attempt's session, started on its first step, and again after a step that closed it. */
function hold(ctx: StepExecutorContext, agent: Agent, memoryKey: string): Held {
  const { memory } = ctx.attempt;
  const existing = memory.get(memoryKey) as Held | undefined;
  if (existing !== undefined && !existing.agent.closed) return existing;
  const slot: StepSlot = { active: undefined, halt: () => session.cancel() };
  const tools = stepTools(slot, ctx, agent.extra);
  const session = holdSession({
    launch: agent.launch,
    registerLogin: agent.registerLogin,
    tools,
    attempt: ctx.attempt,
    signal: ctx.signal,
    ownTool: (title) => {
      // Run in the tail of a step that already ended: no step to fail, so no later step gets this conversation.
      if (slot.active === undefined) return session.close();
      slot.active.denied ??= title;
      session.cancel();
    },
  });
  const held: Held = { agent: session, slot, tools, turn: undefined };
  memory.set(memoryKey, held);
  return held;
}

/** The message for one step: the rules on the first, then the step, what already ran, and the screen. */
async function stepMessage(active: ActiveStep, tools: readonly ServedTool[], introduction: (string | undefined)[] | undefined): Promise<string> {
  const { ctx } = active;
  const parts: string[] = [];
  if (introduction !== undefined) parts.push(...introduction.filter((part): part is string => part !== undefined && part.trim() !== ''));
  const { step } = ctx;
  parts.push(`${step.kind === 'assert' ? 'Assertion' : 'Step'}: ${step.instruction}`);
  const params = plainParams(step.params);
  if (params !== undefined) parts.push(`Parameters: ${JSON.stringify(params)}`);
  if (step.secrets.length > 0) {
    parts.push(`Secrets to fill with type_secret, by name: ${step.secrets.map((secret) => `${secret.name} (${secret.purpose})`).join(', ')}`);
  }
  const missing = missingTools(active, tools);
  if (missing.length > 0) parts.push(`Not offered in this step: ${missing.join(', ')}.`);
  if (ctx.ledger !== '') parts.push(`Steps completed so far in this test, including any replayed without you:\n${ctx.ledger}`);
  const prefix = ctx.replayedPrefix;
  if (prefix !== undefined) {
    parts.push(
      `A cached replay already performed these actions for this step: ${prefix.replayedActions.join('; ')}. It stopped (${prefix.stopReason}). Continue from the current screen; do not redo them.`,
    );
    if (prefix.uncertainAction !== undefined) {
      parts.push(`This replayed action may have taken effect although it failed: ${prefix.uncertainAction}. Check the screen before doing anything like it again.`);
    }
  }
  parts.push(await openingScreen(active));
  return parts.join('\n\n');
}

/** The params without secret placeholders, which are listed by name instead. */
function plainParams(params: Readonly<Record<string, JsonValue>> | undefined): Record<string, JsonValue> | undefined {
  if (params === undefined) return undefined;
  const plain = Object.fromEntries(
    Object.entries(params).filter(([, value]) => !isSecretPlaceholder(value)),
  );
  return Object.keys(plain).length === 0 ? undefined : plain;
}

/** A secret in the params, as the runner projects it: `{ kind: 'secret', name, purpose }`. */
function isSecretPlaceholder(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, JsonValue>)['kind'] === 'secret';
}

/** Whether `promise` settles within `ms`; rejects with the step's reason if the step ends first. */
async function settled(promise: Promise<unknown> | undefined, ms: number, signal: AbortSignal): Promise<boolean> {
  if (promise === undefined) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const done = promise.then(
    () => true,
    () => true,
  );
  return untilAborted(Promise.race([done, timeout]), signal).finally(() => clearTimeout(timer));
}

/** The verdict of a step where the agent acted with a tool of its own, which the runner neither saw nor recorded. */
function ownToolUsed(title: string): StepVerdict {
  return {
    status: 'failed',
    errorCode: 'POLICY_DENIED',
    summary: `The agent ran a tool of its own without asking (${title}); only the step tools may act, so the step was stopped.`,
  };
}

function noConclusion(report: TurnReport): StepVerdict {
  // Redacted whole, before the last line is taken and cut: a value can span lines, and half a key is no longer a match.
  const text = redactSecrets(report.text.trim());
  const said = text.slice(text.lastIndexOf('\n') + 1).slice(0, 300);
  return {
    status: 'failed',
    errorCode: 'STEP_NO_CONCLUSION',
    summary: `The agent ended its turn (${report.stopReason}) without complete_step${said === '' ? '' : `: ${said}`}`,
  };
}

function transcript(prompt: string, active: ActiveStep, report: TurnReport): string {
  return [
    `> ${prompt}`,
    `tools: ${active.calls.join(', ') || 'none'}`,
    ...(report.rejected.length === 0 ? [] : [`rejected tools of the agent's own: ${report.rejected.join(', ')}`]),
    ...(report.ran.length === 0 ? [] : [`tools of the agent's own that ran without asking: ${report.ran.join(', ')}`]),
    `stop: ${report.stopReason}`,
    report.text,
  ].join('\n');
}

/** The options with `added` after the executor's own `system`. */
function withSystem(options: AcpAgentOptions, added: string | undefined): AcpAgentOptions {
  const system = [options.system, added].filter((part): part is string => part !== undefined && part.trim() !== '').join('\n\n');
  return system === '' ? options : { ...options, system };
}
