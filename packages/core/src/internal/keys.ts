/** The harness-side check of a `press` key against the contract's key grammar. */

import { KEY_MODIFIERS, KEY_NAMES, REMOTE_KEY_NAMES, isRemoteKey, parseKey, type KeyName, type RemoteKeyName } from '../engine/contract.ts';
import { ConfigurationError, TestError } from './errors.ts';

/** The keyboard key a remote button's name most likely meant on a target with no remote. */
const KEYBOARD_FOR_REMOTE: Readonly<Partial<Record<RemoteKeyName, KeyName>>> = {
  home: 'Home',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  select: 'Enter',
  back: 'Escape',
};

/**
 * Throws `INVALID_ARGUMENT` for anything but a key of the grammar, and
 * `UNSUPPORTED_CAPABILITY` for a TV remote key when the target's engine does
 * not declare `remoteKeys`, naming the keyboard key of the same word when
 * there is one.
 */
export function requireKey(key: unknown, remoteKeys: boolean): asserts key is string {
  if (typeof key === 'string' && isRemoteKey(key)) {
    if (remoteKeys) return;
    const keyboard = KEYBOARD_FOR_REMOTE[key];
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `"${key}" is a TV remote key, and this target's engine does not declare remoteKeys` +
        (keyboard === undefined ? '' : `; for the keyboard key press "${keyboard}"`),
    );
  }
  if (typeof key === 'string' && parseKey(key) !== undefined) return;
  throw new TestError(
    'INVALID_ARGUMENT',
    `press key ${JSON.stringify(key)} is not a key: use zero or more modifiers (${KEY_MODIFIERS.join(', ')}) ` +
      `and one key joined by "+", where the key is a single character or one of ${KEY_NAMES.join(', ')}, ` +
      `or one TV remote button with no modifier (${REMOTE_KEY_NAMES.join(', ')}) ` +
      '(for example "Enter", "Control+a", "Shift+Tab", "menu")',
  );
}
