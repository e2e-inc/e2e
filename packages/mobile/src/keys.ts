/** The contract's keyboard keys as a touch surface takes them. */

import { KEY_NAMES, REMOTE_KEY_NAMES, parseKey, type KeyName, type RemoteKeyName } from '@e2e-dev/core/engine';
import { unsupported } from './support.ts';

/** What agent-device can send for a key: Enter through the soft keyboard, or text typed into the focused field. */
export type SoftKey = { readonly kind: 'enter' } | { readonly kind: 'text'; readonly text: string };

/** The remote key a keyboard key's user most likely meant on a TV. */
const REMOTE_FOR_KEYBOARD: Readonly<Partial<Record<KeyName, RemoteKeyName>>> = {
  Home: 'home',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Escape: 'back',
};

/**
 * One keyboard key of the contract's grammar as the device sends it.
 * agent-device exposes no key event bus, so modifiers and the named keys
 * other than `Enter` and `Space` have nothing to land on: they are
 * `UNSUPPORTED_CAPABILITY`, naming the remote button to press instead when
 * there is one.
 */
export function softKey(key: string): SoftKey {
  const parsed = parseKey(key);
  if (parsed === undefined) {
    throw unsupported(`"${key}" is not a key: press takes one key in the form [Modifier+]...Key, a named key (${KEY_NAMES.join(', ')}) or one character`);
  }
  if (parsed.modifiers.length > 0) {
    throw unsupported(`agent-device cannot hold ${parsed.modifiers.join('+')} on a device surface; press the key alone`);
  }
  if (parsed.key.kind === 'char') return { kind: 'text', text: parsed.key.char };
  if (parsed.key.name === 'Enter') return { kind: 'enter' };
  if (parsed.key.name === 'Space') return { kind: 'text', text: ' ' };
  const remote = REMOTE_FOR_KEYBOARD[parsed.key.name];
  throw unsupported(
    `agent-device cannot press ${parsed.key.name} on a device surface; only Enter, Space, and single characters reach the soft keyboard. ` +
      (remote === undefined
        ? `On a TV, press a remote button by its lowercase name: ${REMOTE_KEY_NAMES.join(', ')}`
        : `On a TV, the remote's button is "${remote}"`),
  );
}
