/** How the agent's press tools read a key: whether it only moves focus, and how the remote keys are offered. */

import { isRemoteKey, parseKey, REMOTE_KEY_NAMES, type KeyName, type RemoteKeyName } from '../engine/contract.ts';

/**
 * Keys whose whole effect is where the focus or the caret sits, which the
 * tree does not record. An unchanged screen after one of these is the normal
 * outcome, not a control that did nothing.
 */
const FOCUS_ONLY_KEYS: ReadonlySet<KeyName> = new Set(['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** The TV remote's D-pad: it moves the focus between views, which the tree may not record either. */
const FOCUS_ONLY_REMOTE_KEYS: ReadonlySet<RemoteKeyName> = new Set(['up', 'down', 'left', 'right']);

/**
 * Whether a key only moves the focus or the caret, read through the key
 * grammar so the remote's `home`, which leaves the app, is not the keyboard's
 * `Home`.
 */
export function movesFocusOnly(key: string): boolean {
  if (isRemoteKey(key)) return FOCUS_ONLY_REMOTE_KEYS.has(key);
  const parsed = parseKey(key);
  return parsed?.key.kind === 'named' && FOCUS_ONLY_KEYS.has(parsed.key.name);
}

/**
 * The remote keys, for the press tool of a target whose engine declares
 * `remoteKeys`: the model otherwise reaches for the keyboard's capitalised
 * names.
 */
export const REMOTE_KEY_HINT = ` A TV remote's buttons are lowercase: ${REMOTE_KEY_NAMES.join(', ')} ("home" is the remote's, "Home" the keyboard's).`;
