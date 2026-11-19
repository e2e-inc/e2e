/**
 * The text of one console line, from what a browser hands over of the
 * call's arguments. Chromium's DevTools protocol gives each a remote object:
 * a class name, a preview of its first fields, an error's own description.
 * WebDriver BiDi gives a remote value: an object's entries, but no class
 * name and nothing of an error, so there the browser's own text stands
 * wherever it says more. Either way an object shows its own first fields,
 * never a nested one's, and a line stays one line of bounded parts; the
 * harness redacts and clips the whole.
 *
 * The harness redacts a secret where its whole value stands, so a text a
 * browser cut short is never printed in part. Chromium cuts every value
 * inside a preview (`PropertyPreview.value`: a string, an error's message
 * and stack, a regular expression, a symbol, a node, a class name) and
 * every description of a BigInt down to `PREVIEW_CUT` characters, with an
 * ellipsis in its middle or at its end. An argument's own value,
 * description, and class name, a BigInt's `unserializableValue`, and a
 * field's name come whole, as does every string of a BiDi remote value and
 * Firefox's own text.
 */

import type { Protocol } from 'devtools-protocol';
import type { Script } from 'webdriver-bidi-protocol';

/** How many fields, items, or entries of one logged object, array, map, or set a line shows before it ends in an ellipsis. */
const MAX_SHOWN = 5;

/**
 * The length Chromium cuts a text inside a preview down to. One that long
 * may be what is left of a longer one, and is left out of the line: what is
 * left of a secret would no longer match it, and so escape the harness's
 * redaction.
 */
const PREVIEW_CUT = 100;

/** The first `MAX_SHOWN` of `parts`, with an ellipsis when there are more, or `more` says the browser left some out. */
function listed(parts: readonly string[], more = false): string {
  const shown = parts.slice(0, MAX_SHOWN);
  return more || parts.length > MAX_SHOWN ? [...shown, '…'].join(', ') : shown.join(', ');
}

/** A string as it reads inside an object or array: quoted, so an empty one and one with a comma stay apart from their neighbours. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

/**
 * One field, item, key, or value of a CDP preview, of `type` and `subtype`
 * and printed by Chromium as `text`: a primitive as it is, a string quoted,
 * an error as its message and stack, any other object as its class name, a
 * function as its type. A text of `PREVIEW_CUT` characters or more is left
 * out, whole or not: a string reads as an elision mark, anything else as
 * its subtype (`error`, `regexp`, `node`) or its type.
 */
function previewValue(type: string, subtype: string | undefined, text: string | undefined): string {
  if (type === 'function') return 'function';
  if (text !== undefined && text.length >= PREVIEW_CUT) return type === 'string' ? '"…"' : (subtype ?? type);
  if (type === 'string') return quoted(text ?? '');
  return text ?? type;
}

/** A CDP preview of an object, array, map, or set as one bounded line; `name` is the class name it carries, none for a plain object or an array. */
function previewText(preview: Protocol.Runtime.ObjectPreview, name: string): string {
  const prefix = name === '' ? '' : `${name} `;
  if (preview.entries !== undefined) {
    const part = (side: Protocol.Runtime.ObjectPreview): string => previewValue(side.type, side.subtype, side.description);
    const entries = preview.entries.map((entry) => (entry.key === undefined ? part(entry.value) : `${part(entry.key)} => ${part(entry.value)}`));
    return `${prefix}{${listed(entries, preview.overflow)}}`;
  }
  if (preview.subtype === 'array' || preview.subtype === 'typedarray') return `${prefix}[${listed(preview.properties.map((item) => previewValue(item.type, item.subtype, item.value)), preview.overflow)}]`;
  return `${prefix}{${listed(preview.properties.map((property) => `${property.name}: ${previewValue(property.type, property.subtype, property.value)}`), preview.overflow)}}`;
}

/**
 * One CDP remote object as a console line shows it: a primitive as it
 * prints, an error as its own description (its message and stack), a node
 * as its tag, an object as its class name (none for a plain one) with its
 * first fields, an array as its first items, a map or set with its size and
 * first entries. Each is read off what Chromium hands over whole: a BigInt
 * off its `unserializableValue`, never its description.
 */
function cdpText(object: Protocol.Runtime.RemoteObject): string {
  if (object.type === 'string') return String(object.value);
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.type === 'undefined' || object.type === 'function') return object.type;
  if (object.type !== 'object') return object.description ?? String(object.value);
  if (object.subtype === 'null') return 'null';
  if (object.subtype === 'node') return `<${object.description ?? 'node'}>`;
  const preview = object.preview;
  const described = object.description ?? object.className ?? 'Object';
  if (preview === undefined || object.subtype === 'error' || object.subtype === 'date' || object.subtype === 'regexp') return described;
  if (preview.entries !== undefined) return previewText(preview, described);
  if (preview.subtype === 'array') return previewText(preview, '');
  return previewText(preview, described === 'Object' ? '' : described);
}

/**
 * The line of one console call from its CDP arguments: the printf-style
 * specifiers of a leading string are filled from the arguments after it as
 * the console fills them (`%s`, `%d`, `%i`, `%f`, `%o`, `%O`; `%c` takes its
 * style and prints nothing), one with no argument left stays as written,
 * and the arguments no specifier took follow, joined by spaces. A number
 * specifier prints a number alone: any other argument is `NaN`, where the
 * console would print the digits a text starts with, since the part of a
 * secret is not redacted from the app log as the whole of it is.
 */
export function cdpConsoleText(args: readonly Protocol.Runtime.RemoteObject[]): string {
  const [first, ...rest] = args;
  if (first?.type !== 'string') return args.map(cdpText).join(' ');
  const left = [...rest];
  const head = String(first.value).replace(/%[sdifoOc]/g, (specifier) => {
    const arg = left.shift();
    if (arg === undefined) return specifier;
    if (specifier === '%c') return '';
    if (specifier === '%s' || specifier === '%o' || specifier === '%O') return cdpText(arg);
    if (arg.type === 'bigint') return cdpText(arg);
    if (arg.type !== 'number') return 'NaN';
    return String(specifier === '%f' ? Number.parseFloat(cdpText(arg)) : Number.parseInt(cdpText(arg), 10));
  });
  return [head, ...left.map(cdpText)].join(' ');
}

/**
 * The text of an exception nothing caught, from CDP's details of it.
 * Chromium hands the thrown value over beside a bare `Uncaught` or
 * `Uncaught (in promise)`: an error reads as its own description (its
 * message and stack), anything else as that line and the value, as a
 * console line shows it (`Uncaught boom`, `Uncaught (in promise) {code: 1}`).
 * It hands no value over for a script of another origin loaded without
 * CORS, nor for code evaluated over the protocol; its line then names what
 * was thrown (`Uncaught boom`), and stands alone.
 */
export function cdpExceptionText(details: Protocol.Runtime.ExceptionDetails): string {
  const { exception, text } = details;
  if (exception === undefined) return text;
  return exception.subtype === 'error' ? cdpText(exception) : `${text} ${cdpText(exception)}`;
}

/** Whether a BiDi remote value says more than the browser's text of it does: an object, array, map, or set with the entries the browser serialized, an element with its tag. */
function saysMoreThanItsText(value: Script.RemoteValue): boolean {
  if (value.type === 'node') return value.value?.localName !== undefined;
  return (value.type === 'object' || value.type === 'array' || value.type === 'map' || value.type === 'set') && value.value !== undefined;
}

/** An element as its tag with its id and classes, as Chromium describes one (`<output#total.sum>`); any other node, or one the browser serialized nothing of, as `<node>`. */
function nodeText(node: Script.NodeProperties | undefined): string {
  if (node?.localName === undefined) return '<node>';
  const id = node.attributes?.['id'] ?? '';
  const classes = (node.attributes?.['class'] ?? '').split(/\s+/).filter((name) => name !== '');
  return `<${node.localName}${id === '' ? '' : `#${id}`}${classes.map((name) => `.${name}`).join('')}>`;
}

/** A BiDi remote value inside an object, array, map, or set: a primitive as it prints, a string quoted, anything with fields of its own as its kind. */
function nestedText(value: Script.RemoteValue | string): string {
  if (typeof value === 'string') return value;
  if (value.type === 'string') return quoted(value.value);
  if (value.type === 'object') return 'Object';
  if ((value.type === 'array' || value.type === 'map' || value.type === 'set') && value.value !== undefined) return `${kindOf(value.type)}(${String(value.value.length)})`;
  return bidiText(value);
}

/** `Array`, `Map`, `Set`: a BiDi type name as the class it names. */
function kindOf(type: string): string {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

/**
 * One BiDi remote value as a console line shows it: a primitive as it
 * prints, an object with its first fields, an array with its first items, a
 * map or set with its size and first entries, a node as its tag, a regular
 * expression and a date as written, and anything BiDi serializes nothing of
 * (an error, a function, an instance of a platform class) as its type.
 */
function bidiText(value: Script.RemoteValue): string {
  switch (value.type) {
    case 'string':
    case 'boolean':
    case 'date':
      return String(value.value);
    case 'number':
      return String(value.value);
    case 'bigint':
      return `${value.value}n`;
    case 'regexp':
      return `/${value.value.pattern}/${value.value.flags ?? ''}`;
    case 'node':
      return nodeText(value.value);
    case 'object':
      return value.value === undefined ? 'object' : `{${listed(value.value.map(([key, field]) => `${nestedText(key)}: ${nestedText(field)}`))}}`;
    case 'array':
      return value.value === undefined ? 'array' : `[${listed(value.value.map(nestedText))}]`;
    case 'map':
      return value.value === undefined ? 'map' : `Map(${String(value.value.length)}) {${listed(value.value.map(([key, field]) => `${typeof key === 'string' ? quoted(key) : nestedText(key)} => ${nestedText(field)}`))}}`;
    case 'set':
      return value.value === undefined ? 'set' : `Set(${String(value.value.length)}) {${listed(value.value.map(nestedText))}}`;
    default:
      return value.type;
  }
}

/**
 * The line of one BiDi console entry: the browser's own `text`, which holds
 * the filled format string and an error's message, unless an argument is an
 * object, array, map, or set, of which that text gives only a size
 * (`Object(2)`), or an element, of which it gives only `node`; then every
 * argument reads as its remote value does, where an error is its type
 * alone, since BiDi serializes nothing of one.
 */
export function bidiConsoleText(text: string, args: readonly Script.RemoteValue[]): string {
  return args.some(saysMoreThanItsText) ? args.map(bidiText).join(' ') : text;
}
