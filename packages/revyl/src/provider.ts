/**
 * Revyl's hosted iOS simulators and Android emulators as a `DeviceProvider`
 * for the mobile engine, through agent-device's `@agent-device/revyl` plugin:
 * each lease comes from its own agent-device daemon, which starts a Revyl
 * device with the app installed from an `https` URL, or with no app and
 * then the target's local `app.appPath` installed on it. Video is the
 * worker's own screen recording of that device.
 */

import path from 'node:path';
import type { DeviceLease, DeviceProvider, DeviceRequest } from '@e2e-dev/mobile';
import { agentDeviceLeases, agentDevicePlugin, type LeaseSelectors } from '@e2e-dev/mobile/lease';
import { ConfigurationError, rejectUnknownKeys, type ProviderRecordContext, type ProviderRecording, type ProviderRecordingResult } from 'e2e/engine';
import { credentialsEnv, revylCredentials, type RevylCredentials } from './credentials.ts';
import { RecordingGone, RevylDeviceClient } from './devices.ts';

/** agent-device's name for Revyl, as the lease provider and the tenant. */
const PROVIDER = 'revyl';

const PLUGIN = import.meta.resolve('@agent-device/revyl');
const plugin = agentDevicePlugin(PLUGIN);
const RECORDING_FILE = 'recording.mp4';

/** Every option `revyl()` takes, kept equal to `RevylOptions` by the compiler. */
const OPTION_KEYS: readonly string[] = Object.keys({
  app: true,
  device: true,
  osVersion: true,
} satisfies Record<keyof RevylOptions, true>);

/** What `revyl()` takes: the build Revyl installs, and the device model it runs on. */
export interface RevylOptions {
  /**
   * `https` URL Revyl downloads the build from when it starts each device: an
   * iOS simulator build (`.app` zipped) or an Android `.apk`. A local path is
   * refused, since Revyl cannot read it; name a local build with the target's
   * `app.appPath` instead. Absent, the device starts with no app, and the
   * target's `app.appPath`, when it has one, is installed on it.
   */
  readonly app?: string | undefined;
  /** Device model as Revyl lists it: `iPhone 17 Pro Max`, `Pixel 7`. */
  readonly device: string;
  /** OS version as Revyl lists it for that model: `iOS 27.0`, `Android 14`. Absent, Revyl's default for the model. */
  readonly osVersion?: string | undefined;
}

/**
 * Revyl devices for `mobile({ device: revyl({ app, device }) })`: one hosted
 * device and isolated agent-device daemon per worker slot. Allocating the
 * lease starts the Revyl device, which installs `app`; releasing it ends the
 * device session via the daemon before stopping it (falling back to daemon
 * stop if the RPC does not confirm release). An attempt that records video
 * gets the worker's screen recording of the device.
 */
export function revyl(options: RevylOptions): DeviceProvider {
  rejectUnknownKeys('revyl()', options, OPTION_KEYS);
  const device: unknown = options.device;
  if (typeof device !== 'string' || device.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'revyl: `device` is required, as a non-empty string');
  }
  const osVersion: unknown = options.osVersion;
  if (osVersion !== undefined && (typeof osVersion !== 'string' || osVersion.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'revyl: `osVersion` must be a non-empty string');
  }
  const app: unknown = options.app;
  if (app !== undefined && (typeof app !== 'string' || !isHttpsUrl(app))) {
    // The value is left out: a rejected URL can carry credentials or a presigned signature.
    throw new ConfigurationError('INVALID_CONFIG', 'revyl: `app` must be an https URL, without credentials, that Revyl can download the build from');
  }
  const leases = agentDeviceLeases({ provider: PROVIDER, label: 'Revyl' });

  return {
    name: PROVIDER,
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      plugin.assertVersion(request.agentDeviceVersion);
      if (request.appPath !== undefined && app !== undefined) {
        throw new Error("Revyl installs the app from `app`; leave the target's `app.appPath` out, or leave `app` out to install that build instead");
      }
      const credentials = revylCredentials(request.env);
      const selectors = {
        device,
        ...(app === undefined ? {} : { providerApp: app }),
        ...(options.osVersion === undefined ? {} : { providerOsVersion: options.osVersion }),
      } satisfies LeaseSelectors;
      return leases.acquire(request, {
        env: credentialsEnv(credentials),
        selectors,
        summary: `${device}, ${options.osVersion ?? request.platform}; Revyl device started`,
        prepareHome: plugin.prepareHome,
        installAppPath: true,
      }).catch(async (error: unknown) => {
        if (!/\bHTTP 422\b/.test(error instanceof Error ? error.message : String(error))) throw error;
        throw (await unlisted(credentials, request, device, options.osVersion, error)) ?? error;
      });
    },
    release: (lease, context) => leases.release(lease, context),
    // Runs in the worker, from the lease alone: the plugin starts the device under a session id it derives from `lease.id`.
    async record(lease: DeviceLease, context: ProviderRecordContext): Promise<ProviderRecording> {
      const { revylSessionIdForLease } = (await import(PLUGIN)) as { revylSessionIdForLease: (leaseId: string) => string };
      const client = new RevylDeviceClient(revylCredentials(context.env));
      const recording = await client.startRecording(revylSessionIdForLease(lease.id), context.signal);
      // A stop the engine repeats shares one in flight and reuses one that ended the recording; a failed stop is asked again on the next call.
      let stopped: Promise<ProviderRecordingResult> | undefined;
      return {
        startedAt: recording.startedAt,
        stop: ({ dir, signal }) =>
          (stopped ??= client.stopRecording(recording, path.join(dir, RECORDING_FILE), signal).then(
            () => ({ file: RECORDING_FILE }),
            (error: unknown) => {
              if (error instanceof RecordingGone) return { none: error.message };
              stopped = undefined;
              throw error;
            },
          )),
      };
    },
  };
}

/**
 * After Revyl refused a lease with a 422, the error naming the models or OS
 * versions Revyl lists when `device` or `osVersion` is not among them:
 * Revyl itself answers an unknown one with a bare 422. Asked only once the
 * allocation refused, since the allocation also takes aliases the catalog
 * does not list, such as `Pixel7`, a bare API level, or a retired iOS beta.
 * Nothing when Revyl lists both or does not answer.
 */
async function unlisted(credentials: RevylCredentials, request: DeviceRequest, device: string, osVersion: string | undefined, cause: unknown): Promise<Error | undefined> {
  const catalog = await new RevylDeviceClient(credentials).catalog(request.platform, request.signal).catch(() => undefined);
  if (catalog === undefined || catalog.models.length === 0) return undefined;
  if (!catalog.models.includes(device)) {
    return new Error(`Revyl has no ${request.platform} device "${device}"; set \`device\` to one of: ${catalog.models.join(', ')}`, { cause });
  }
  const versions = catalog.runtimes[device] ?? [];
  if (osVersion !== undefined && versions.length > 0 && !versions.includes(osVersion)) {
    return new Error(`Revyl runs "${device}" on ${versions.join(', ')}, not "${osVersion}"; set \`osVersion\` to one of those, or leave it out for Revyl's default`, { cause });
  }
  return undefined;
}

/** An `https` URL without credentials in it, the only app source the Revyl plugin accepts. */
function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}
