/** A toy engine served in this process over the engine protocol, and the contexts its hooks take. */

import { tmpdir } from 'node:os';
import {
  connectEngine,
  defineEngine,
  describeEngine,
  loopbackTransport,
  type Engine,
  type EngineAttemptContext,
  type EngineHandle,
  type EngineInitInfo,
  type OperationContext,
  type SemanticNode,
} from '@e2e-dev/core/lib/engine/index';

const node = (id: string, name: string, role = 'button'): SemanticNode => ({ ref: { id, revision: '' }, role, name });

export const ROOT: SemanticNode = { ref: { id: 'root', revision: '' }, role: 'root', children: [node('n1', 'Save'), node('n2', 'Cancel')] };

export const operation = (signal: AbortSignal = new AbortController().signal): OperationContext => ({
  signal,
  timeoutMs: 1000,
  runId: 'run',
  attemptId: 'attempt-1',
  origin: 'test',
});

export const initInfo = (log: (line: string) => void = () => {}): EngineInitInfo => ({
  runId: 'run',
  targetName: 'toy',
  projectRoot: process.cwd(),
  app: {},
  env: process.env,
  headed: false,
  workerSlot: 0,
  signal: new AbortController().signal,
  log,
});

export const cleanup = { signal: new AbortController().signal, timeoutMs: 1000 };

/** Serves `engine` in this process and returns the client handle over it. */
export function overLoopback(engine: Engine, extra: Partial<Parameters<typeof connectEngine>[0]> = {}): { local: EngineHandle; remote: EngineHandle } {
  const local = defineEngine(engine);
  return { local, remote: connectEngine({ manifest: describeEngine(local), transport: loopbackTransport(local), ...extra }) };
}

export const toy = (extra: Partial<Engine> = {}): Engine => ({
  name: 'toy',
  version: '1.0.0',
  spiVersion: 1,
  observe: async () => ({ root: ROOT, viewport: { width: 1280, height: 720 } }),
  ...extra,
});

/** What `startAttempt` takes for `attemptId`, with callbacks that do nothing but the ones `overrides` gives. */
export const attemptContext = (attemptId: string, overrides: Partial<EngineAttemptContext> = {}): EngineAttemptContext => ({
  attemptId,
  artifactsDir: tmpdir(),
  signal: new AbortController().signal,
  resolveSecret: async () => '',
  appLog: () => {},
  navigation: () => {},
  environment: () => {},
  ...overrides,
});
