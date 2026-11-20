import { GRAMMAR_TOOL_NAMES } from '@e2e-dev/core/lib/agent/action-names';
import { ActionDispatcher } from '@e2e-dev/core/lib/agent/action-dispatcher';
import { loadAiSdkIfInstalled } from '@e2e-dev/core/lib/agent/ai-sdk';
import type { StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';
import type { AgentContext } from '@e2e-dev/core/lib/agent/invocation';
import { ObservationFeed } from '@e2e-dev/core/lib/agent/observation-feed';
import { OperationQueue } from '@e2e-dev/core/lib/agent/operation-queue';
import { executorRedactors } from '@e2e-dev/core/lib/agent/redaction';
import { ScreenPresenter } from '@e2e-dev/core/lib/agent/screen-update';
import { StepAccounting } from '@e2e-dev/core/lib/agent/step-accounting';
import { classifyError, ConfigurationError, errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { abortError, cancelledError, Deadline, withAbort } from '@e2e-dev/core/lib/internal/time';
import { LocatorEngine } from '@e2e-dev/core/lib/locator/engine';
import { StepRecorder } from '@e2e-dev/core/lib/run/steps';
import type { SessionCatalog } from '../../mcp/catalog.ts';
import { actionResult, catalogLine, describeToolDetail, errorResult, invokeTool, redactResult } from '../../mcp/tools.ts';
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
    private readonly agent: string,
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
            if (request.name === 'screenshot' && Object.hasOwn(request.args, 'path')) {
              throw new ConfigurationError(
                'INVALID_ARGUMENT',
                'Unsupported "path" argument for screenshot. An attached session returns the image without saving a file.',
              );
            }

            const result = await this.run(requestId, attachment, (signal) =>
              invokeTool(request.name, this.tool(catalog, request.name), request.args, { signal }),
            );
            const output = GRAMMAR_TOOL_NAMES.has(request.name) ? actionResult(request.name, result) : result;

            return { kind: 'call', result: redactResult(output, redact) };
          } catch (cause) {
            return { kind: 'call', result: redactResult(errorResult(cause), redact) };
          }
        }
      }
    } catch (cause) {
      const { category, code, message } = classifyError(cause);

      return { kind: 'error', error: { category, code, message: redact(message) } };
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
      const summary = `Attached to ${attachId}, "${title}" on target "${target.name}".`;

      return {
        kind: 'attach',
        opening: {
          target: redact(target.name),
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

    if (name === 'type_secret') {
      throw new ConfigurationError(
        'POLICY_DENIED',
        "type_secret requires secrets in step parameters. Attachments don't have step parameters.",
      );
    }

    throw new ConfigurationError('UNKNOWN_TOOL', `tool "${name}" is not available in this attachment`);
  }

  /** Runs one call at a time and releases its queue slot as soon as it is cancelled. */
  private async run<T>(requestId: string, attachment: Attachment, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const request = new AbortController();
    attachment.requests.set(requestId, request);
    const signal = AbortSignal.any([attachment.signal, request.signal]);

    try {
      return await attachment.queue.run(async () => {
        const call = { signal, running: true };
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
      import('../../mcp/catalog.ts'),
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
    const engine = new LocatorEngine({
      session,
      budget,
      redact,
      runId: this.runId,
      attemptId: this.attemptId,
      actionTimeout: config.actionTimeout,
      assertionTimeout: config.assertionTimeout,
    });

    // The tools need a recorder. Use an empty one to keep their activity out of the test report.
    const runtime: AgentContext = {
      ...this.runtime,
      engine,
      steps: new StepRecorder(this.attemptId),
    };
    const { debug: _debug, ...unrecorded } = runtime;

    const accounting = new StepAccounting(unrecorded, {
      api: 'attachment',
      timeoutMs: 0,
      maxActions: Number.POSITIVE_INFINITY,
      maxModelCalls: 0,
      contextBytes: 0,
      callSignal: () => budget.signal,
    });

    const queue = new OperationQueue();
    const agent = config.agents.get(this.agent) ?? config.agent;

    const feed = new ObservationFeed(unrecorded, accounting, queue, {
      pixelsAllowed: true,
      maxObservationBytes: agent.maxObservationBytes,
      maxInputTokens: agent.maxInputTokens,
      instructionBytes: 0,
    });

    const dispatcher = new ActionDispatcher(unrecorded, accounting, feed, queue, {
      instruction: '',
      params: undefined,
      secrets: new Map(),
      trace: () => undefined,
    });

    const context: StepExecutorContext = {
      step: {
        kind: 'act',
        index: 0,
        instruction: '',
        params: undefined,
        secrets: [],
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
      observe: (options) => feed.observe(options),
      read: (target, options) => feed.read(target, options),
      actions: dispatcher.actions,
      budgets: {
        maxActions: accounting.maxActions,
        maxModelCalls: accounting.maxModelCalls,
        actionsUsed: () => accounting.metrics.actionSteps,
        remainingMs: () => accounting.remainingMs(),
        recordModelCall: (usage) => accounting.recordModelCall(usage),
        runTool: (call, body) => dispatcher.runTool(call, body),
      },
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
      recorder: undefined,
      warn: () => undefined,
      appBase: runtime.app.base,
    });
  }
}
