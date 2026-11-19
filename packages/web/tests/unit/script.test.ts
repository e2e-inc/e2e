/**
 * Page functions across the BiDi wire: results as JSON, nodes and windows as
 * references, anything else kept as unreadable, and a function passed a node
 * run only in that node's document, a node Firefox could not hand to the
 * call being one of another.
 */

import { describe, expect, it } from 'vitest';
import { validateJsonValue } from '@e2e-dev/core/engine';
import { FakeBidi } from '../helpers/bidi-fake.ts';
import { callFunction, ElementRef, UnreadableValue, WindowRef } from '../../src/driver/script.ts';

/** A peer whose page function returns `result`. */
function returning(result: unknown) {
  return new FakeBidi().on('script.callFunction', { result: { type: 'success', realm: 'r', result } });
}

/** A node as the check of a call's nodes reads it. */
interface PageNode {
  readonly ownerDocument: object | null;
}

/**
 * A peer that runs each page function it is sent as a page showing `shown`
 * would, with the nodes its arguments name by shared id, and answers with
 * the string the function returns.
 */
function pageShowing(shown: PageNode, nodes: Readonly<Record<string, PageNode>>): FakeBidi {
  const revive = (value: { sharedId?: string; type?: string; value?: unknown }): unknown => {
    if (value.sharedId !== undefined) return nodes[value.sharedId];
    if (value.type === 'array') return (value.value as never[]).map(revive);
    if (value.type === 'object') return Object.fromEntries((value.value as [string, never][]).map(([key, entry]) => [key, revive(entry)]));
    return value.value;
  };
  return new FakeBidi().on('script.callFunction', (params) => {
    const fn = (new Function('document', `return (${String(params['functionDeclaration'])});`) as (document: PageNode) => (...args: unknown[]) => string)(shown);
    return { result: { type: 'success', realm: 'r', result: { type: 'string', value: fn(...(params['arguments'] as never[]).map(revive)) } } };
  });
}

describe('callFunction', () => {
  it('sends a function passed no node as it is', async () => {
    const fake = returning({ type: 'null' });
    await callFunction(fake.connection, 'tab', '(a, b) => null', [1, { among: ['two'] }]);
    expect(fake.commands('script.callFunction')[0]!.params['functionDeclaration']).toBe('(a, b) => null');
  });

  it('runs a function only in the document of every node it is passed, and fails one passed a node of another document as the browser refuses a node', async () => {
    const shown = { ownerDocument: null, ran: 0 };
    const fake = pageShowing(shown, { here: { ownerDocument: shown }, gone: { ownerDocument: { ownerDocument: null } }, document: shown });
    const count = '() => { document.ran += 1; return "ran"; }';
    await expect(callFunction(fake.connection, 'tab', count, [new ElementRef('here'), { among: [1, new ElementRef('here')] }, new ElementRef('document')])).resolves.toBe('ran');
    expect(shown.ran).toBe(1);
    for (const args of [[new ElementRef('gone')], [new ElementRef('here'), { among: [1, new ElementRef('gone')] }]]) {
      await expect(callFunction(fake.connection, 'tab', count, args)).rejects.toMatchObject({ name: 'BidiError', error: 'no such node' });
    }
    expect(shown.ran).toBe(1);
  });

  it('fails a call Firefox could not hand a node to, one of another origin of the same site, as the browser refuses a node', async () => {
    const unpassed = { error: 'unknown error', message: 'Error: Not allowed to define cross-origin object as property on [Object] or [Array] XrayWrapper' };
    const fake = new FakeBidi().on('script.callFunction', unpassed);
    for (const args of [[new ElementRef('gone')], [{ among: [1, new ElementRef('gone')] }]]) {
      await expect(callFunction(fake.connection, 'tab', '() => null', args)).rejects.toMatchObject({ name: 'BidiError', error: 'no such node' });
    }
    await expect(callFunction(fake.connection, 'tab', '() => null', [1])).rejects.toMatchObject({ name: 'BidiError', error: 'unknown error' });
  });

  it('reads nodes and windows as references, and keeps an own __proto__ key', async () => {
    const fake = returning({
      type: 'object',
      value: [
        ['node', { type: 'node', sharedId: 's1' }],
        ['window', { type: 'window', value: { context: 'c1' } }],
        ['__proto__', { type: 'string', value: 'kept' }],
      ],
    });
    const value = (await callFunction(fake.connection, 'tab', '() => 0')) as Record<string, unknown>;
    expect(value['node']).toEqual(new ElementRef('s1'));
    expect(value['window']).toEqual(new WindowRef('c1'));
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
  });

  it('keeps a value with no JSON form as unreadable, which a JSON check refuses', async () => {
    const value = await callFunction(returning({ type: 'date', value: '2026-11-01T00:00:00.000Z' }).connection, 'tab', '() => new Date()');
    expect(value).toEqual(new UnreadableValue('date'));
    expect(() => validateJsonValue(value, 'evaluate result')).toThrow('evaluate result must be JSON-safe');
  });

  it('keeps an object the result holds twice, and a cycle as a cycle a JSON check refuses', async () => {
    const shared = { type: 'object', internalId: 'o1', value: [['n', { type: 'number', value: 1 }]] };
    const aliased = (await callFunction(returning({ type: 'object', value: [['a', shared], ['b', { type: 'object', internalId: 'o1' }]] }).connection, 'tab', '() => 0')) as Record<string, unknown>;
    expect(aliased['b']).toBe(aliased['a']);
    expect(aliased['b']).toEqual({ n: 1 });
    const cyclic = await callFunction(returning({ type: 'object', internalId: 'o2', value: [['self', { type: 'object', internalId: 'o2' }]] }).connection, 'tab', '() => 0');
    expect(() => validateJsonValue(cyclic, 'evaluate result')).toThrow('contains a cycle');
  });
});
