/**
 * The text of a console line from a browser's own account of the call's
 * arguments: CDP remote objects, with their previews, and BiDi remote
 * values, with the browser's text beside them.
 */

import { describe, expect, it } from 'vitest';
import type { Protocol } from 'devtools-protocol';
import type { Script } from 'webdriver-bidi-protocol';
import { bidiConsoleText, cdpConsoleText, cdpExceptionText } from '../../src/driver/console-text.ts';

type RemoteObject = Protocol.Runtime.RemoteObject;

const text = (value: string): RemoteObject => ({ type: 'string', value });
const number = (value: number): RemoteObject => ({ type: 'number', value, description: String(value) });

/** A CDP object of `className` with a preview of `properties`, cut short when `overflow`. */
function object(className: string, properties: Protocol.Runtime.PropertyPreview[], overflow = false): RemoteObject {
  return { type: 'object', className, description: className, preview: { type: 'object', description: className, overflow, properties } };
}

/** A secret a page logs, which the harness redacts only where it stands whole. */
const SECRET = 'sk_live_9f31c7a2d4e5';

/** `value` as Chromium cuts a string, a regular expression, or a BigInt over 100 characters inside a preview: its first 50, an ellipsis, its last 49. */
const cutInMiddle = (value: string): string => `${value.slice(0, 50)}…${value.slice(-49)}`;

/** `value` as Chromium cuts anything else over 100 characters inside a preview: its first 99 and an ellipsis. */
const cutAtEnd = (value: string): string => `${value.slice(0, 99)}…`;

describe('cdpConsoleText', () => {
  it('joins the arguments by spaces, each primitive as it prints', () => {
    expect(cdpConsoleText([text('plain'), number(1), { type: 'boolean', value: true }, { type: 'undefined' }, { type: 'object', subtype: 'null', value: null }, { type: 'number', unserializableValue: 'NaN' }, { type: 'bigint', unserializableValue: '12n' }, { type: 'symbol', description: 'Symbol(s)' }, { type: 'function', className: 'Function', description: '() => 1' }]))
      .toBe('plain 1 true undefined null NaN 12n Symbol(s) function');
    expect(cdpConsoleText([])).toBe('');
  });

  it('fills the specifiers of a leading string, leaves one with no argument as written, and appends the arguments none took', () => {
    expect(cdpConsoleText([text('%s is %d, %i or %f'), text('x'), number(5.9), number(7), number(1.5)])).toBe('x is 5, 7 or 1.5');
    expect(cdpConsoleText([text('%c styled'), text('color: red'), text('after'), number(2)])).toBe(' styled after 2');
    expect(cdpConsoleText([text('Sale: 10%off, %s left')])).toBe('Sale: 10%off, %s left');
    expect(cdpConsoleText([text('%o and %O'), object('Object', [{ name: 'a', type: 'number', value: '1' }]), text('raw')])).toBe('{a: 1} and raw');
    expect(cdpConsoleText([text('%d'), text('none')])).toBe('NaN');
  });

  it('prints a number for a number alone, never the digits a text starts with', () => {
    expect(cdpConsoleText([text('%d %i %f'), text('4821-secret'), text('7px'), text('1.5em')])).toBe('NaN NaN NaN');
    expect(cdpConsoleText([text('%d %f'), { type: 'bigint', unserializableValue: '12n' }, { type: 'number', unserializableValue: 'Infinity' }])).toBe('12n Infinity');
    expect(cdpConsoleText([text('%d'), object('Object', [{ name: 'a', type: 'number', value: '1' }])])).toBe('NaN');
  });

  it('shows an object\'s first fields, strings quoted, a nested object as its class, and an ellipsis for what the preview left out', () => {
    const fields: Protocol.Runtime.PropertyPreview[] = [
      { name: 'code', type: 'number', value: '1006' },
      { name: 'reason', type: 'string', value: '' },
      { name: 'wasClean', type: 'boolean', value: 'false' },
      { name: 'nested', type: 'object', value: 'Object' },
      { name: 'none', type: 'object', subtype: 'null', value: 'null' },
    ];
    expect(cdpConsoleText([object('Object', fields)])).toBe('{code: 1006, reason: "", wasClean: false, nested: Object, none: null}');
    expect(cdpConsoleText([object('Object', fields, true)])).toBe('{code: 1006, reason: "", wasClean: false, nested: Object, none: null, …}');
    expect(cdpConsoleText([object('Object', [...fields, { name: 'sixth', type: 'number', value: '6' }])])).toBe('{code: 1006, reason: "", wasClean: false, nested: Object, none: null, …}');
  });

  it('names the class of an instance before its fields, and an instance with no preview by its class alone', () => {
    expect(cdpConsoleText([object('Point', [{ name: 'x', type: 'number', value: '1' }])])).toBe('Point {x: 1}');
    expect(cdpConsoleText([{ type: 'object', className: 'Event', description: 'Event' }])).toBe('Event');
  });

  it('reads an error as its own description, a node as its tag, a date and a regular expression as written', () => {
    const error: RemoteObject = { type: 'object', subtype: 'error', className: 'Error', description: 'Error: boom\n    at app.js:1:7', preview: { type: 'object', subtype: 'error', description: 'Error: boom', overflow: false, properties: [{ name: 'stack', type: 'string', value: 'Error: boom' }] } };
    expect(cdpConsoleText([text('Failed'), error])).toBe('Failed Error: boom\n    at app.js:1:7');
    expect(cdpConsoleText([{ type: 'object', subtype: 'node', className: 'HTMLBodyElement', description: 'body' }])).toBe('<body>');
    expect(cdpConsoleText([{ type: 'object', subtype: 'regexp', className: 'RegExp', description: '/re/g', preview: { type: 'object', subtype: 'regexp', description: '/re/g', overflow: false, properties: [] } }])).toBe('/re/g');
  });

  it('shows an array\'s first items and a map\'s and a set\'s first entries with their size', () => {
    const items: Protocol.Runtime.PropertyPreview[] = [
      { name: '0', type: 'number', value: '1' },
      { name: '1', type: 'string', value: 'two' },
      { name: '2', type: 'object', value: 'Object' },
    ];
    expect(cdpConsoleText([{ type: 'object', subtype: 'array', className: 'Array', description: 'Array(3)', preview: { type: 'object', subtype: 'array', description: 'Array(3)', overflow: false, properties: items } }])).toBe('[1, "two", Object]');
    const entry = (type: Protocol.Runtime.ObjectPreview['type'], description: string): Protocol.Runtime.ObjectPreview => ({ type, description, overflow: false, properties: [] });
    expect(cdpConsoleText([{ type: 'object', subtype: 'map', className: 'Map', description: 'Map(1)', preview: { type: 'object', subtype: 'map', description: 'Map(1)', overflow: false, properties: [], entries: [{ key: entry('string', 'k'), value: entry('number', '1') }] } }])).toBe('Map(1) {"k" => 1}');
    expect(cdpConsoleText([{ type: 'object', subtype: 'set', className: 'Set', description: 'Set(1)', preview: { type: 'object', subtype: 'set', description: 'Set(1)', overflow: false, properties: [], entries: [{ value: entry('object', 'Object') }] } }])).toBe('Set(1) {Object}');
  });

  it('leaves a string Chromium may have cut inside a preview out of the line, and keeps a shorter one whole', () => {
    const fields: Protocol.Runtime.PropertyPreview[] = [
      { name: 's99', type: 'string', value: 's'.repeat(99) },
      { name: 's100', type: 'string', value: 's'.repeat(100) },
      { name: 's101', type: 'string', value: cutInMiddle('s'.repeat(101)) },
    ];
    expect(cdpConsoleText([object('Object', fields)])).toBe(`{s99: "${'s'.repeat(99)}", s100: "…", s101: "…"}`);
    expect(cdpConsoleText([text('n'.repeat(500))])).toBe('n'.repeat(500));
  });

  it('never prints a part of what Chromium cut inside an object: an error, a regular expression, a symbol, a BigInt, a node, and a class name read as their type', () => {
    const failure = `Error: 401 for https://api.test/v1/accounts/7f3c2a9e/sessions/current/save?retry=2&key=${SECRET}\n    at save (https://app.test/app.js:8:30)`;
    const fields: Protocol.Runtime.PropertyPreview[] = [
      { name: 'error', type: 'object', subtype: 'error', value: cutAtEnd(failure) },
      { name: 'r', type: 'object', subtype: 'regexp', value: cutInMiddle(`/${'z'.repeat(40)}${SECRET}${'z'.repeat(60)}/`) },
      { name: 's', type: 'symbol', value: cutAtEnd(`Symbol(${'q'.repeat(85)}${SECRET})`) },
      { name: 'b', type: 'bigint', value: cutInMiddle(`1${'0'.repeat(200)}n`) },
      { name: 'el', type: 'object', subtype: 'node', value: cutAtEnd(`div#${'i'.repeat(200)}`) },
    ];
    const line = cdpConsoleText([text('save failed'), object('Object', fields)]);
    expect(line).toBe('save failed {error: error, r: regexp, s: symbol, b: bigint, el: node}');
    expect(line).not.toContain(SECRET.slice(0, 4));
    expect(cdpConsoleText([object('Object', [{ name: 'c', type: 'object', value: cutAtEnd('A'.repeat(200)) }, { name: 'f', type: 'function', value: '' }])])).toBe('{c: object, f: function}');
    const items: Protocol.Runtime.PropertyPreview[] = [{ name: '0', type: 'object', subtype: 'error', value: cutAtEnd(failure) }];
    expect(cdpConsoleText([{ type: 'object', subtype: 'array', className: 'Array', description: 'Array(1)', preview: { type: 'object', subtype: 'array', description: 'Array(1)', overflow: false, properties: items } }])).toBe('[error]');
  });

  it('keeps an error inside an object whole when Chromium cut nothing of it', () => {
    const whole = 'Error: in array\n    at http://127.0.0.1:53589/throws:12:38';
    expect(cdpConsoleText([object('Object', [{ name: 'e', type: 'object', subtype: 'error', value: whole }])])).toBe(`{e: ${whole}}`);
  });

  it('leaves a long key or value of a map or set out of the line, which Chromium hands over whole but for a BigInt', () => {
    const entry = (type: Protocol.Runtime.ObjectPreview['type'], description: string, subtype?: Protocol.Runtime.ObjectPreview['subtype']): Protocol.Runtime.ObjectPreview => ({ type, ...(subtype === undefined ? {} : { subtype }), description, overflow: false, properties: [] });
    const failure = `Error: ${'e'.repeat(85)}${SECRET}\n    at <anonymous>:7:14`;
    const entries: Protocol.Runtime.EntryPreview[] = [
      { key: entry('string', SECRET), value: entry('object', failure, 'error') },
      { key: entry('string', 'k'.repeat(200)), value: entry('bigint', cutInMiddle(`1${'0'.repeat(200)}n`)) },
      { key: entry('symbol', `Symbol(${'q'.repeat(200)})`), value: entry('function', 'function f() {}') },
    ];
    expect(cdpConsoleText([{ type: 'object', subtype: 'map', className: 'Map', description: 'Map(3)', preview: { type: 'object', subtype: 'map', description: 'Map(3)', overflow: false, properties: [{ name: 'size', type: 'number', value: '3' }], entries } }]))
      .toBe(`Map(3) {"${SECRET}" => error, "…" => bigint, symbol => function}`);
  });

  it('prints an argument of its own whole, as Chromium hands it over: an error\'s message and stack, a BigInt off its unserializable value', () => {
    const description = `Error: ${'m'.repeat(200)}${SECRET}\n    at <anonymous>:7:14`;
    const preview: Protocol.Runtime.ObjectPreview = { type: 'object', subtype: 'error', description, overflow: false, properties: [{ name: 'stack', type: 'string', value: cutInMiddle(description) }, { name: 'message', type: 'string', value: cutInMiddle(`${'m'.repeat(200)}${SECRET}`) }] };
    expect(cdpConsoleText([{ type: 'object', subtype: 'error', className: 'Error', description, preview }])).toBe(description);
    const digits = `1${'0'.repeat(200)}n`;
    expect(cdpConsoleText([{ type: 'bigint', unserializableValue: digits, description: cutInMiddle(digits) }])).toBe(digits);
    expect(cdpConsoleText([{ type: 'symbol', description: `Symbol(${'q'.repeat(200)})` }])).toBe(`Symbol(${'q'.repeat(200)})`);
  });
});

describe('cdpExceptionText', () => {
  const details = { exceptionId: 1, lineNumber: 3, columnNumber: 20, scriptId: '10', url: 'http://app.test/' };
  /** What Chromium reports of `exception` thrown by a script of the page: the value beside a bare line, `Uncaught (in promise)` for a rejection nothing handled. */
  const thrown = (exception: RemoteObject, line = 'Uncaught'): string => cdpExceptionText({ ...details, text: line, exception });

  it('reads an uncaught error as its own description, thrown or rejected', () => {
    expect(thrown({ type: 'object', subtype: 'error', className: 'RangeError', description: 'RangeError: render loop exceeded\n    at app.js:8:30' })).toBe('RangeError: render loop exceeded\n    at app.js:8:30');
    const rejected = 'Error: x\n    at http://app.test/:9:36';
    expect(thrown({ type: 'object', subtype: 'error', className: 'Error', description: rejected, preview: { type: 'object', subtype: 'error', description: rejected, overflow: false, properties: [{ name: 'stack', type: 'string', value: rejected }, { name: 'message', type: 'string', value: 'x' }] } }, 'Uncaught (in promise)')).toBe(rejected);
  });

  it('names a thrown value that is no error after Chromium\'s bare line, as a console line shows it', () => {
    expect(thrown({ type: 'string', value: 'boom' })).toBe('Uncaught boom');
    expect(thrown({ type: 'string', value: 'payment declined' }, 'Uncaught (in promise)')).toBe('Uncaught (in promise) payment declined');
    expect(thrown(object('Object', [{ name: 'code', type: 'string', value: 'E_AUTH' }]))).toBe('Uncaught {code: "E_AUTH"}');
    expect(thrown(object('Object', [{ name: 'code', type: 'number', value: '1' }]), 'Uncaught (in promise)')).toBe('Uncaught (in promise) {code: 1}');
    expect(thrown({ type: 'number', value: 42, description: '42' })).toBe('Uncaught 42');
    expect(thrown({ type: 'object', subtype: 'null', value: null })).toBe('Uncaught null');
    expect(thrown({ type: 'undefined' })).toBe('Uncaught undefined');
    expect(thrown(object('Custom', [{ name: 'reason', type: 'string', value: 'r' }]))).toBe('Uncaught Custom {reason: "r"}');
  });

  it('never prints a part of what Chromium cut inside a thrown object, and prints a thrown string whole', () => {
    const failure = `Error: ${'x'.repeat(85)}${SECRET}\n    at http://app.test/:33:21`;
    expect(thrown(object('Object', [{ name: 'e', type: 'object', subtype: 'error', value: cutAtEnd(failure) }]))).toBe('Uncaught {e: error}');
    expect(thrown({ type: 'string', value: `${'s'.repeat(200)}${SECRET}` })).toBe(`Uncaught ${'s'.repeat(200)}${SECRET}`);
  });

  it('keeps Chromium\'s line alone when it hands no value over, which then names what was thrown', () => {
    expect(cdpExceptionText({ ...details, text: 'Uncaught boom' })).toBe('Uncaught boom');
    expect(cdpExceptionText({ ...details, text: 'Uncaught (in promise) #<Object>' })).toBe('Uncaught (in promise) #<Object>');
    expect(cdpExceptionText({ ...details, text: 'Uncaught SyntaxError: Unexpected end of input' })).toBe('Uncaught SyntaxError: Unexpected end of input');
  });
});

describe('bidiConsoleText', () => {
  const string = (value: string): Script.RemoteValue => ({ type: 'string', value });
  const count = (value: number): Script.RemoteValue => ({ type: 'number', value });

  it('keeps the browser\'s text for a line of primitives and errors, which holds the filled format string and an error\'s message', () => {
    expect(bidiConsoleText('x is 5', [string('x is 5')])).toBe('x is 5');
    expect(bidiConsoleText('Failed TypeError: bad thing', [string('Failed'), { type: 'error' }])).toBe('Failed TypeError: bad thing');
    expect(bidiConsoleText('object', [{ type: 'object' }])).toBe('object');
  });

  it('shows an object\'s first fields in place of its size, strings quoted, a nested object, array, map, and set as its kind', () => {
    const logged: Script.RemoteValue = { type: 'object', value: [
      ['a', count(1)],
      ['reason', string('')],
      ['nested', { type: 'object', value: [['b', count(2)]] }],
      ['list', { type: 'array', value: [count(1), count(2)] }],
      ['seen', { type: 'set', value: [count(1)] }],
      ['sixth', count(6)],
    ] };
    expect(bidiConsoleText('user Object(6)', [string('user'), logged])).toBe('user {a: 1, reason: "", nested: Object, list: Array(2), seen: Set(1), …}');
  });

  it('shows an array\'s first items and a map\'s and a set\'s first entries with their size', () => {
    expect(bidiConsoleText('Array(3)', [{ type: 'array', value: [count(1), string('two'), { type: 'null' }] }])).toBe('[1, "two", null]');
    expect(bidiConsoleText('Map(1) Set(1)', [{ type: 'map', value: [['k', count(1)]] }, { type: 'set', value: [string('a')] }])).toBe('Map(1) {"k" => 1} Set(1) {"a"}');
    expect(bidiConsoleText('Map(1)', [{ type: 'map', value: [[{ type: 'object', value: [] }, { type: 'undefined' }]] }])).toBe('Map(1) {Object => undefined}');
  });

  it('reads a logged element as its tag with its id and classes, where the browser\'s text says only node', () => {
    const element = (attributes: Record<string, string>): Script.RemoteValue => ({ type: 'node', sharedId: 'n', value: { nodeType: 1, childNodeCount: 1, localName: 'output', attributes } });
    expect(bidiConsoleText('node', [element({ id: 'total', class: ' sum  wide ' })])).toBe('<output#total.sum.wide>');
    expect(bidiConsoleText('node', [element({})])).toBe('<output>');
    expect(bidiConsoleText('total node', [string('total'), element({ id: 'total' })])).toBe('total <output#total>');
    expect(bidiConsoleText('node', [{ type: 'node', sharedId: 't', value: { nodeType: 3, childNodeCount: 0, nodeValue: 'text' } }])).toBe('node');
    expect(bidiConsoleText('node', [{ type: 'node', sharedId: 'n' }])).toBe('node');
  });

  it('reads every other argument beside an object as its remote value: an error as its type, since BiDi serializes nothing of one', () => {
    const args: Script.RemoteValue[] = [
      { type: 'object', value: [] }, { type: 'error' }, { type: 'bigint', value: '12' }, { type: 'number', value: 'NaN' }, { type: 'boolean', value: false },
      { type: 'regexp', value: { pattern: 're', flags: 'g' } }, { type: 'date', value: '1970-01-01T00:00:00.000Z' }, { type: 'node', sharedId: 'n', value: { nodeType: 1, childNodeCount: 0, localName: 'div' } },
      { type: 'function' }, { type: 'symbol' }, { type: 'window', value: { context: 'c' } }, { type: 'undefined' }, { type: 'null' },
    ];
    expect(bidiConsoleText('ignored', args)).toBe('{} error 12n NaN false /re/g 1970-01-01T00:00:00.000Z <div> function symbol window undefined null');
  });
});
