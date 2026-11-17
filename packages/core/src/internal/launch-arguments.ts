/**
 * The shape of `launchArguments`, checked once for the runner's config and
 * for a launch a test asks for by hand, so an engine never spells a value
 * the declaration did not allow.
 */

import { ConfigurationError, TestError } from './errors.ts';
import { isPlainObject } from './options.ts';
import type { LaunchArgumentValue, LaunchArguments } from '../types.ts';

const LAUNCH_ARGUMENTS_SHAPE = 'an array of strings or an object of argument name to string, number, boolean, or array of strings';

/**
 * Launch arguments as declared: a list of strings, or a plain object of
 * argument name (non-empty, no whitespace or control characters) to string,
 * finite number below 2^53 in magnitude, boolean, or list of strings, none
 * holding a NUL character. An `undefined` value, read from the
 * environment, is the entry left out. `code` picks the error: a target's
 * config fails with `INVALID_CONFIG`, a test's own launch with
 * `INVALID_ARGUMENT`.
 */
export function checkLaunchArguments(label: string, declared: unknown, code: 'INVALID_CONFIG' | 'INVALID_ARGUMENT' = 'INVALID_CONFIG'): LaunchArguments | undefined {
  if (declared === undefined) return undefined;
  if (Array.isArray(declared)) {
    const index = declared.findIndex((argument) => typeof argument !== 'string');
    if (index !== -1) {
      fail(code, `${label} must be ${LAUNCH_ARGUMENTS_SHAPE}; item ${index} is ${describe(declared[index])}`);
    }
    const nul = declared.findIndex((argument: string) => argument.includes('\u0000'));
    if (nul !== -1) fail(code, `${label} item ${nul} holds a NUL character`);
    return declared as readonly string[];
  }

  if (!isPlainObject(declared)) {
    fail(code, `${label} must be ${LAUNCH_ARGUMENTS_SHAPE}, got ${describe(declared)}`);
  }
  const entries: [string, LaunchArgumentValue][] = [];
  for (const [name, value] of Object.entries(declared)) {
    if (value === undefined) continue;
    if (name === '') fail(code, `${label} has an empty argument name`);
    if (/[\s\p{Cc}]/u.test(name)) {
      fail(code, `${label} argument name ${JSON.stringify(name)} must have no whitespace or control characters`);
    }
    if (!isLaunchArgumentValue(value)) {
      fail(code, `${label}.${name} must be a string, number, boolean, or array of strings, got ${describe(value)}`);
    }
    if (holdsNul(value)) fail(code, `${label}.${name} holds a NUL character`);
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

/** A string, a boolean, a finite number below 2^53 in magnitude, or a list of strings with no hole. */
function isLaunchArgumentValue(value: unknown): value is LaunchArgumentValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  return Array.isArray(value) && value.findIndex((item) => typeof item !== 'string') === -1;
}

function holdsNul(value: LaunchArgumentValue): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  return Array.isArray(value) && value.some((item) => item.includes('\u0000'));
}

/** A value's kind for an error message: `null`, `an array`, `a Map`, `an object`, `NaN`, `a number beyond 2^53`, `a number`. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') {
    const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return isPlainObject(value) ? 'an object' : typeof name === 'string' && name !== '' ? `a ${name}` : 'an object';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) return 'a number beyond 2^53';
  }
  return `a ${typeof value}`;
}

function fail(code: 'INVALID_CONFIG' | 'INVALID_ARGUMENT', message: string): never {
  throw code === 'INVALID_CONFIG' ? new ConfigurationError(code, message) : new TestError(code, message);
}
