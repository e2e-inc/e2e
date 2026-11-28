/**
 * The desktop engine server on the Revyl Mac: `serveEngine(desktop)` over
 * stdio, as the relay starts it, with the paths that name the runner's
 * machine moved onto this one. The project root, where the app path
 * resolves, becomes the Mac's own project directory, and the app path the
 * build the runner uploaded. An attempt's artifact directory becomes one on
 * the Mac, and each screenshot written there goes back as its bytes, which
 * the client writes into the attempt's directory on the runner. The answer
 * to `prepare` hands the workers this computer and its uploaded app.
 *
 * Copied to the Mac with `relay.ts`, `frames.ts`, and `wire.ts`, into the directory
 * where npm installed the engine.
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { serveEngine } from '@e2e-dev/core/engine';
import { desktop, type DesktopOptions } from '@e2e-dev/desktop/engine';
import { frame, FrameReader, type Message } from './frames.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = path.join(ROOT, 'project');
const ARTIFACTS = path.join(ROOT, 'artifacts');
/** Variables the runner's transport reads in each worker. */
const HANDED = ['E2E_REVYL_COMPUTER', 'E2E_REVYL_APP'] as const;

type Params = Record<string, unknown> & { app?: Record<string, unknown> };
type Id = number | string;

/** Requests whose answers are rewritten on the way back, by id. */
const screenshots = new Set<Id>();
const prepares = new Set<Id>();
let attemptDir = ARTIFACTS;

/** A transform that hands each whole frame to `rewrite`, in order, and passes on what it returns. */
function frames(rewrite: (message: Message) => Promise<Message | undefined>): Transform {
  const reader = new FrameReader();
  return new Transform({
    async transform(chunk: Buffer, _encoding, done: TransformCallback) {
      try {
        for (const { bytes, message } of reader.push(chunk)) {
          const rewritten = message === undefined ? undefined : await rewrite(message);
          this.push(rewritten === undefined ? bytes : frame(rewritten));
        }
        done();
      } catch (cause) {
        done(cause as Error);
      }
    },
  });
}

/** The client's messages, with the runner's paths replaced by the Mac's. */
const fromClient = frames(async (message) => {
  const params = message.params as Params | undefined;
  if (message.id === undefined || message.id === null || typeof params !== 'object' || params === null) return undefined;
  switch (message.method) {
    case 'artifacts/screenshot':
      screenshots.add(message.id);
      return undefined;
    case 'lifecycle/startAttempt':
      attemptDir = path.join(ARTIFACTS, String(params['attemptId']).replace(/[^A-Za-z0-9_-]/g, '_'));
      await mkdir(attemptDir, { recursive: true });
      return { ...message, params: { ...params, artifactsDir: attemptDir } };
    case 'lifecycle/prepare':
    case 'lifecycle/init':
    case 'lifecycle/doctor': {
      if (message.method === 'lifecycle/prepare') prepares.add(message.id);
      const app = process.env['E2E_REVYL_APP'];
      return {
        ...message,
        params: { ...params, projectRoot: PROJECT, ...(params.app === undefined || app === undefined ? {} : { app: { ...params.app, appPath: app } }) },
      };
    }
    default:
      return undefined;
  }
});

/** The server's messages, with each screenshot's path replaced by its bytes and the workers' variables added to `prepare`'s answer. */
const toClient = frames(async (message) => {
  if (message.method !== undefined || message.id === undefined || message.id === null || message.error !== undefined) return undefined;
  if (screenshots.delete(message.id)) {
    const written = (message.result as { path?: unknown } | null)?.path;
    if (typeof written !== 'string') return undefined;
    return { ...message, result: { data: (await readFile(path.resolve(attemptDir, written))).toString('base64'), mediaType: 'image/png' } };
  }
  if (prepares.delete(message.id)) {
    const result = (message.result ?? {}) as { env?: Record<string, string> };
    const handed = Object.fromEntries(HANDED.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])));
    return { ...message, result: { ...result, env: { ...result.env, ...handed } } };
  }
  return undefined;
});

process.stdin.pipe(fromClient);
toClient.pipe(process.stdout);
await serveEngine((options) => desktop(options as DesktopOptions), { input: fromClient, output: toClient });
process.exit(0);
