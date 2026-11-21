/** The key grammar's TV remote buttons, pressed through agent-device's `tv-remote`. */

import { REMOTE_KEY_NAMES, TestError, isRemoteKey, type RemoteKeyName } from '@e2e-dev/core/engine';
import type { AgentDeviceClient } from './options.ts';
import type { InputBudget } from './support.ts';

type TvRemoteButton = Parameters<AgentDeviceClient['command']['tvRemote']>[0]['button'];

/**
 * agent-device's button for each remote key. On an Apple TV, `back` and
 * `menu` press the same Siri Remote button, which goes back. `play` is the dedicated Play
 * button; the one that toggles, which most Android TV remotes carry, is
 * `play-pause`. agent-device serves `tv-remote` on Android TV and tvOS
 * targets only, so any other device refuses every button, and an Apple TV
 * refuses the media buttons; either reaches the test as
 * `UNSUPPORTED_CAPABILITY`.
 */
const REMOTE_BUTTONS = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  select: 'select',
  back: 'back',
  menu: 'menu',
  home: 'home',
  play: 'media-play',
  pause: 'media-pause',
  'play-pause': 'media-play-pause',
  stop: 'media-stop',
  rewind: 'media-rewind',
  'fast-forward': 'media-fast-forward',
  next: 'media-next',
  previous: 'media-previous',
} as const satisfies Record<RemoteKeyName, TvRemoteButton>;

/** A TV remote key `device.pressRemote` takes: one of the key grammar's `REMOTE_KEY_NAMES`. */
export type RemoteKey = RemoteKeyName;

/** Presses one remote button, within the operation's budget. */
export function pressRemote(client: AgentDeviceClient, key: RemoteKey, input: InputBudget): Promise<unknown> {
  return input.send(() => client.command.tvRemote({ button: REMOTE_BUTTONS[key] }));
}

/** Throws `INVALID_ARGUMENT` unless `key` is one of the remote keys. */
export function requireRemoteKey(key: unknown): asserts key is RemoteKey {
  if (typeof key === 'string' && isRemoteKey(key)) return;
  throw new TestError('INVALID_ARGUMENT', `device.pressRemote(${JSON.stringify(key)}): not a remote key; press one of ${REMOTE_KEY_NAMES.join(', ')}`);
}
