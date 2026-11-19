/**
 * The ffmpeg that encodes Chromium's screencast: a system one with VP9, or
 * the pinned ffmpeg-static build downloaded into the browsers cache on first
 * recording.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { EngineError } from '@e2e-dev/core/engine';
import { browserPlatform, installArchive, PINS } from './builds.ts';
import { mirrorOrigin } from './download.ts';
import { browsersPath, installBuilds, type PinnedBuild } from './provision.ts';

/** Where the pinned ffmpeg-static release is downloaded from, unless `E2E_BROWSERS_DOWNLOAD_HOST` names a mirror. */
const FFMPEG_HOST = 'https://github.com';

/** Whether `executable` runs and lists the VP9 encoder the screencast needs. */
function encodesVp9(executable: string): boolean {
  const result = spawnSync(executable, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 && result.stdout.includes('libvpx-vp9');
}

/** The cached ffmpeg's directory. */
function cachedFfmpegDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(browsersPath(env), `ffmpeg-${PINS.ffmpeg.buildId}`);
}

/** The cached ffmpeg's path for this platform. */
function cachedFfmpeg(env: NodeJS.ProcessEnv): string {
  return path.join(cachedFfmpegDirectory(env), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

/** `ffmpeg` on the PATH when it encodes VP9, else null; probed once and memoized. */
let systemFfmpeg: string | null | undefined;

/**
 * The ffmpeg that encodes Chromium's screencast: `E2E_FFMPEG_PATH` as given,
 * never probed; else the build `ensureFfmpeg` cached; else `ffmpeg` on the
 * PATH when it encodes VP9. Undefined when there is none yet.
 */
function ffmpegExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env['E2E_FFMPEG_PATH'];
  if (configured !== undefined && configured !== '') return configured;
  const cached = cachedFfmpeg(env);
  if (existsSync(cached)) return cached;
  systemFfmpeg ??= encodesVp9('ffmpeg') ? 'ffmpeg' : null;
  return systemFfmpeg ?? undefined;
}

/** What `ensureFfmpeg` reports to and stops on. */
export interface FfmpegContext {
  /** Receives what it downloads; silent when omitted. */
  readonly log?: ((line: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The ffmpeg that encodes Chromium's screencast, downloading the pinned
 * build into the browsers cache when the system has none: from the
 * `E2E_BROWSERS_DOWNLOAD_HOST` mirror when set, checked against its
 * SHA-256, under the cache's install lock. The build is the browsers'
 * platform's, so Windows on Arm gets the x64 one beside its x64 browsers.
 * Throws `UNSUPPORTED_CAPABILITY` on a platform with no pinned build, and
 * `BROWSER_INSTALL_FAILED` when the download fails.
 */
export async function ensureFfmpeg(env: NodeJS.ProcessEnv, context: FfmpegContext = {}): Promise<string> {
  const existing = ffmpegExecutable(env);
  if (existing !== undefined) return existing;
  const platform = browserPlatform()?.node;
  if (platform === undefined) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `recording video on chromium needs an ffmpeg with libvpx-vp9, and none is pinned for ${process.platform}-${process.arch}: set E2E_FFMPEG_PATH`, { retryable: false });
  }
  const sha256 = PINS.ffmpeg.sha256[platform];
  const executable = cachedFfmpeg(env);
  const url = `${mirrorOrigin(env) ?? FFMPEG_HOST}/eugeneware/ffmpeg-static/releases/download/${PINS.ffmpeg.buildId}/ffmpeg-${platform}.gz`;
  const ffmpeg: PinnedBuild = {
    label: 'ffmpeg',
    announcement: `Downloading ffmpeg from ${url}`,
    recovery: 'run "npx @e2e-dev/web install ffmpeg", or set E2E_FFMPEG_PATH to an ffmpeg with libvpx-vp9',
    executable,
    install: (owner) =>
      installArchive({
        url,
        sha256,
        target: cachedFfmpegDirectory(env),
        isInstalled: () => existsSync(executable),
        unpack: async (archive, root) => {
          const file = path.join(root, path.basename(executable));
          await pipeline(createReadStream(archive), createGunzip(), createWriteStream(file), context.signal === undefined ? {} : { signal: context.signal });
          chmodSync(file, 0o755);
        },
        owner,
        env,
        signal: context.signal,
      }),
  };
  await installBuilds(browsersPath(env), [ffmpeg], { log: context.log ?? (() => undefined), signal: context.signal });
  return executable;
}
