import { GRAMMAR_TOOL_NAMES } from '@e2e-dev/core/lib/agent/action-names';
import { validateParams } from '@e2e-dev/core/lib/agent/act-validation';
import { loadAiSdkIfInstalled } from '@e2e-dev/core/lib/agent/ai-sdk';
import type { StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';
import type { AgentContext } from '@e2e-dev/core/lib/agent/invocation';
import { OperationQueue } from '@e2e-dev/core/lib/agent/operation-queue';
import { executorRedactors } from '@e2e-dev/core/lib/agent/redaction';
import { ScreenPresenter } from '@e2e-dev/core/lib/agent/screen-update';
import { createStepExecution } from '@e2e-dev/core/lib/agent/step-execution';
import type { ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import { classifyError, ConfigurationError, errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { abortError, cancelledError, Deadline, withAbort } from '@e2e-dev/core/lib/internal/time';
import { LocatorEngine } from '@e2e-dev/core/lib/locator/engine';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { createApp } from '@e2e-dev/core/lib/run/fixtures';
import { StepRecorder } from '@e2e-dev/core/lib/run/steps';
import type { SessionCatalog } from '../../session-tools/catalog.ts';
import { actionResult, catalogLine, describeToolDetail, errorResult, invokeTool, redactResult, unavailableSessionTool } from '../../session-tools/tools.ts';
import { sessionFills, sessionSecretLines, sessionSecretParams } from '../../session-tools/secrets.ts';
import { heldTestToolCallScope } from './held-test-tool-scope.ts';
import type { StepAttachmentRequest, StepAttachmentResponse, StepHoldMessage } from './protocol.ts';

type Attachment = {
  readonly id: string;
  catalog: SessionCatalog | undefined;
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  readonly queue: OperationQueue;
  readonly requests: Map<string, AbortController>;
  running: boolean;
};

/** Tool calls on the engine session of a held test attempt. */
export class HeldTestTools {
  private attachment: Attachment | undefined;

  constructor(
    private readonly runtime: AgentContext,
    private readonly runId: string,
    private readonly target: ResolvedTarget,
    private readonly headed: boolean,
  ) {}

  /** The ID of the attempt running in this worker. */
  get attemptId(): string {
    return this.runtime.attempt.attemptId;
  }

  /** The test title and target name, redacted for the attachment. */
  get attachmentLabels(): StepHoldMessage['attachmentLabels'] {
    const { redact, attempt, target } = this.runtime;

    return {
      title: redact(attempt.titlePath.join(' › ')),
      target: redact(target.name),
    };
  }

  /**
   * Whether the attachment is running a call.
   *
   * While true, app logs and screen updates are left out of the test trace.
   */
  get runningCall(): boolean {
    return this.attachment?.running === true;
  }

  /** Handles an attachment request and redacts its reply before sending it. */
  async request(requestId: string, request: StepAttachmentRequest): Promise<StepAttachmentResponse> {
    const { redact } = this.runtime;

    try {
      switch (request.kind) {
        case 'attach':
          return await this.attach(requestId, request.attachId);

        case 'detach':
          if (this.attachment?.id === request.attachmentId) {
            this.end(new ConfigurationError('NO_SESSION', 'the attachment was detached'));
          }

          return { kind: 'detach' };

        case 'detail': {
          const { attachment, catalog } = this.catalogFor(request.attachmentId);

          if (attachment.signal.aborted) {
            throw abortError(attachment.signal, cancelledError);
          }

          const tool = this.tool(catalog, request.name);
          const detail = describeToolDetail(request.name, tool, catalog.readOnly.has(request.name));

          return { kind: 'detail', text: redact(detail) };
        }

        case 'call': {
          const { attachment, catalog } = this.catalogFor(request.attachmentId);

          try {
            return await this.run(requestId, attachment, async (signal) => {
              const result = await invokeTool(request.name, this.tool(catalog, request.name), request.args, { signal });
              const output = GRAMMAR_TOOL_NAMES.has(request.name) ? actionResult(request.name, result) : result;
              const errorCode = heldTestToolCallScope.getStore()?.errorCode;

              return { kind: 'call', result: redactResult(output, redact), errorCode };
            });
          } catch (cause) {
            return {
              kind: 'call',
              result: redactResult(errorResult(cause), redact),
              errorCode: redact(classifyError(cause).code),
            };
          }
        }
      }
    } catch (cause) {
      const { category, code, message } = classifyError(cause);

      return { kind: 'error', error: { category, code: redact(code), message: redact(message) } };
    }
  }

  /** Opens an attachment with a catalog and the screen at the hold. */
  private async attach(requestId: string, attachId: string): Promise<Extract<StepAttachmentResponse, { kind: 'attach' }>> {
    if (this.attachment !== undefined) {
      throw new ConfigurationError('INVALID_ARGUMENT', 'this test already has an attachment');
    }

    const { attempt, redact, target } = this.runtime;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, attempt.signal]);
    const screen = new ScreenPresenter();

    const attachment: Attachment = {
      id: requestId,
      catalog: undefined,
      signal,
      controller,
      queue: new OperationQueue(),
      requests: new Map(),
      running: false,
    };

    this.attachment = attachment;

    try {
      const { catalog, observation } = await this.run(requestId, attachment, async (callSignal) => {
        const openedCatalog = await this.createCatalog(callSignal, signal, screen);
        attachment.catalog = openedCatalog;

        try {
          const firstScreen = screen.initial(await openedCatalog.context.observe());

          return { catalog: openedCatalog, observation: firstScreen };
        } catch (cause) {
          return { catalog: openedCatalog, observation: `No screen to show: ${errorMessage(cause)}` };
        }
      });

      const title = attempt.titlePath.join(' › ');
      const summary = [
        `Attached to ${attachId}, "${title}" on target "${target.name}".`,
        ...sessionSecretLines(this.runtime.config),
      ].join('\n');
      const engine = this.target.engine;

      return {
        kind: 'attach',
        opening: {
          target: redact(target.name),
          platform: redact(target.platform),
          engine: engine === undefined ? undefined : {
            name: redact(engine.name),
            version: redact(engine.version),
          },
          headed: this.headed,
          projectTools: [...catalog.project].map(redact),
          summary: redact(summary),
          catalog: Object.entries(catalog.tools).map(([name, tool]) =>
            catalogLine(name, tool, catalog.readOnly.has(name), redact),
          ),
          observation: redact(observation),
        },
      };
    } catch (cause) {
      if (this.attachment === attachment) {
        this.end(classifyError(cause));
      }

      throw cause;
    }
  }

  /** Finds the attachment and catalog for a call or tool detail request. */
  private catalogFor(attachmentId: string) {
    const attachment = this.attachment;

    if (attachment?.id !== attachmentId || attachment.catalog === undefined) {
      throw new ConfigurationError('NO_SESSION', 'the test resumed');
    }

    return { attachment, catalog: attachment.catalog };
  }

  /** Cancels a single request, including one still waiting its turn. */
  cancel(requestId: string): void {
    this.attachment?.requests.get(requestId)?.abort();
  }

  /** Ends the attachment before a test step can drive the app again. */
  end(reason: Error): void {
    const attachment = this.attachment;

    if (attachment === undefined) {
      return;
    }

    this.attachment = undefined;
    attachment.controller.abort(reason);
  }

  /** Resolves a catalog entry, excluding inherited object members. */
  private tool(catalog: SessionCatalog, name: string): SessionCatalog['tools'][string] {
    const tool = Object.hasOwn(catalog.tools, name) ? catalog.tools[name] : undefined;

    if (tool !== undefined) {
      return tool;
    }

    throw unavailableSessionTool(this.runtime.target.name, catalog, name);
  }

  /** Runs one call at a time and releases its queue slot as soon as it is cancelled. */
  private async run<T>(requestId: string, attachment: Attachment, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const request = new AbortController();
    attachment.requests.set(requestId, request);
    const signal = AbortSignal.any([attachment.signal, request.signal]);

    try {
      return await attachment.queue.run(async () => {
        const call = {
          signal,
          running: true,
          errorCode: undefined,
        };
        attachment.running = true;

        try {
          return await heldTestToolCallScope.run(call, () => withAbort(() => body(signal), signal, cancelledError));
        } finally {
          call.running = false;
          attachment.running = false;
        }
      });
    } finally {
      attachment.requests.delete(requestId);
    }
  }

  /** Builds the reusable grammar and observation context without opening a recorded step. */
  private async createCatalog(callSignal: AbortSignal, signal: AbortSignal, screen: ScreenPresenter): Promise<SessionCatalog> {
    const [{ createSessionCatalog }] = await Promise.all([
      import('../../session-tools/catalog.ts'),
      loadAiSdkIfInstalled(),
    ]);

    if (callSignal.aborted) {
      throw abortError(callSignal, cancelledError);
    }

    const { config, redact, redactCut } = this.runtime;
    const budget = {
      get signal() {
        return heldTestToolCallScope.getStore()?.signal ?? signal;
      },
      deadline: new Deadline(Number.POSITIVE_INFINITY),
    };

    const session = this.runtime.engine.session;
    const engine = this.locator(budget);
    const { debug: _debug, ...runtime } = {
      ...this.runtime,
      engine,
      steps: new StepRecorder(this.attemptId, { redact }),
    };
    const agent = config.agent;
    const { projected, secrets } = validateParams(sessionSecretParams(config), 'session');
    const { accounting, bindings } = createStepExecution(runtime, {
      accounting: {
        api: 'attachment',
        timeoutMs: 0,
        maxActions: Number.POSITIVE_INFINITY,
        maxModelCalls: 0,
        contextBytes: 0,
        callSignal: () => budget.signal,
      },
      observation: {
        pixelsAllowed: true,
        maxObservationBytes: agent.maxObservationBytes,
        maxInputTokens: agent.maxInputTokens,
      },
      actions: {
        instruction: '',
        params: projected,
        secrets,
        trace: () => undefined,
      },
    });

    const context: StepExecutorContext = {
      step: {
        kind: 'act',
        index: 0,
        instruction: '',
        params: projected,
        secrets: [...secrets.values()].map((secret) => ({
          name: secret.name,
          purpose: secret.purpose,
        })),
      },
      attempt: runtime.attempt,
      target: runtime.target,
      get signal() {
        return accounting.signal;
      },
      model: undefined,
      providerOptions: undefined,
      ledger: '',
      agentContext: undefined,
      ...bindings,
      attachTranscript: () => undefined,
      attachTurns: () => undefined,
      attachScreenshot: () => Promise.reject(
        new ConfigurationError('UNSUPPORTED_CAPABILITY', "you can't add screenshot artifacts to a test through an attachment"),
      ),
    };

    executorRedactors.set(context, redact);

    return createSessionCatalog({
      context,
      screen,
      locator: engine,
      session,
      tools: agent.tools,
      redaction: { redact, redactCut },
      projectRoot: config.projectRoot,
      attemptDir: runtime.artifacts.dir,
      recorder: undefined,
      fills: sessionFills(config),
      onActionFailed: (cause) => {
        const call = heldTestToolCallScope.getStore();

        if (call !== undefined) {
          call.errorCode = redact(classifyError(cause).code);
        }
      },
      runCode: {
        engineFixtures: Object.keys(this.target.engine?.fixtures ?? {}),
        attempt: (requestSignal) => {
          const statementBudget = new AttemptBudget(requestSignal ?? signal, new Deadline(Number.POSITIVE_INFINITY));
          const steps = new StepRecorder(this.attemptId, { redact });
          const locator = this.locator(statementBudget);
          const { artifacts } = runtime;

          return {
            agentRuntime: { ...runtime, engine: locator, steps },
            budget: statementBudget,
            session,
            runId: this.runId,
            attemptId: this.attemptId,
            fixtures: {
              app: createApp({
                config,
                steps,
                target: this.target,
                session,
                artifacts,
              }, locator),
            },
          };
        },
      },
      warn: () => undefined,
      appBase: runtime.app.base,
    });
  }

  /** Creates a locator over the held session with the attachment's budget. */
  private locator(budget: Pick<AttemptBudget, 'signal' | 'deadline'>): LocatorEngine {
    const { config, redact } = this.runtime;

    return new LocatorEngine({
      session: this.runtime.engine.session,
      budget,
      redact,
      runId: this.runId,
      attemptId: this.attemptId,
      actionTimeout: config.actionTimeout,
      assertionTimeout: config.assertionTimeout,
    });
  }
}
