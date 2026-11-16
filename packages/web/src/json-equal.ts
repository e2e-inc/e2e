/** Structural equality of JSON values, the comparison `toHaveJSProperty` makes. */
import type { JsonValue } from '@e2e-dev/core/engine';

/**
 * Whether two JSON values are equal: primitives by `===` (so `0` equals
 * `-0`), arrays element by element, objects by the same own keys with equal
 * values in any order. An array never equals an object.
 */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (isJsonArray(a) || isJsonArray(b)) {
    return (
      isJsonArray(a) &&
      isJsonArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]!))
    );
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key]!, b[key]!))
  );
}

/** `Array.isArray` for a JSON value: the built-in does not narrow a readonly array. */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
