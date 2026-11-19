import { describe, expect as vexpect, it } from 'vitest';
import type { SemanticNode } from '@e2e-dev/core/lib/engine/surface';
import type { AsyncExpectation } from '@e2e-dev/core/lib/types';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { createScreenFixture } from '../helpers/screen-fixture.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

let nextId = 0;
/** A node found by its test id, with the fields a case sets. */
function node(testId: string, fields: Omit<SemanticNode, 'ref' | 'testId'>): SemanticNode {
  nextId += 1;
  return { ref: { id: `node-${String(nextId)}`, revision: '' }, testId, ...fields };
}

const NODES: readonly SemanticNode[] = [
  node('field', { role: 'textbox', name: 'Name', attributes: { type: 'text' } }),
  // A device engine reports no attributes at all.
  node('device-field', { role: 'textbox', name: 'Name' }),
  node('native-readonly', { role: 'textbox', name: 'Id', attributes: { readonly: '' } }),
  node('aria-readonly', { role: 'textbox', name: 'Total', attributes: { 'aria-readonly': 'true' } }),
  node('aria-writable', { role: 'searchbox', name: 'Search', attributes: { 'aria-readonly': 'false' } }),
  node('disabled', { role: 'combobox', name: 'Country', states: { disabled: true } }),
  node('checkbox', { role: 'checkbox', name: 'Agree' }),
  node('grid-cell', { role: 'gridcell', name: 'Qty', attributes: { 'aria-readonly': 'true' } }),
  node('secret', { role: 'textbox', name: 'Password', states: { secure: true } }),
  node('button', { role: 'button', name: 'Save' }),
  node('unroled', { text: 'Plain' }),
  node('twin', { role: 'textbox', name: 'One' }),
  node('twin', { role: 'textbox', name: 'Two' }),
];

const screen = createScreenFixture(NODES);
const at = (testId: string): AsyncExpectation => expectFixture(screen.getByTestId(testId));
const soon = { timeout: 100 };
const failsAssertion = { code: 'ASSERTION_FAILED' };
const invalidArgument = { code: 'INVALID_ARGUMENT' };
/** Options typed as the caller's own object, the way a JavaScript test reaches the matcher. */
const computed = (options: Record<string, unknown>): { timeout?: number } => ({ ...options });

describe('toBeEditable', () => {
  it('passes on an enabled control that is not read-only', async () => {
    await at('field').toBeEditable();
    await at('device-field').toBeEditable();
    await at('aria-writable').toBeEditable();
    await at('checkbox').toBeEditable();
    await at('field').not.toBeEditable({ editable: false });
  });

  it('reads the native readonly attribute, whatever its value', async () => {
    await at('native-readonly').not.toBeEditable(soon);
    await vexpect(at('native-readonly').toBeEditable(soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: [
        'expect.toBeEditable failed',
        'locator: getByTestId("native-readonly")',
        'expected: editable',
        'observed: read-only (match count 1)',
      ].join('\n'),
    });
  });

  it('reads aria-readonly="true" on any role that takes it', async () => {
    await at('aria-readonly').not.toBeEditable(soon);
    await at('grid-cell').toBeEditable({ editable: false });
  });

  it('counts a disabled control as not editable', async () => {
    await at('disabled').toBeEditable({ editable: false });
    await vexpect(at('disabled').toBeEditable(soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('observed: disabled (match count 1)'),
    });
  });

  it('flips with editable: false, and names the wanted state', async () => {
    await vexpect(at('field').toBeEditable({ editable: false, timeout: 100 })).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('expected: read-only or disabled\nobserved: editable'),
    });
    await vexpect(at('field').not.toBeEditable(soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('expected: not editable\nobserved: editable'),
    });
  });

  it('fails either way on a node whose role cannot be read-only', async () => {
    for (const testId of ['button', 'unroled']) {
      await vexpect(at(testId).toBeEditable(soon)).rejects.toMatchObject(failsAssertion);
      await vexpect(at(testId).not.toBeEditable(soon)).rejects.toMatchObject(failsAssertion);
    }
    await vexpect(at('button').not.toBeEditable(soon)).rejects.toMatchObject({
      message: vexpect.stringContaining('observed: role "button" (not a control that can be read-only)'),
    });
    await vexpect(at('unroled').toBeEditable(soon)).rejects.toMatchObject({
      message: vexpect.stringContaining('observed: no role (not a control that can be read-only)'),
    });
  });

  it('answers on a secure field, whose editability is not a secret', async () => {
    await at('secret').toBeEditable();
  });

  it('keeps polling while nothing matches, negated or not', async () => {
    await vexpect(at('nowhere').toBeEditable(soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('observed: no node'),
    });
    await vexpect(at('nowhere').not.toBeEditable(soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('observed: no node'),
    });
  });

  it('fails an ambiguous locator at once', async () => {
    await vexpect(at('twin').toBeEditable(soon)).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
  });

  it('refuses a non-boolean flag and an option it does not take, before the first read', () => {
    vexpect(() => at('field').toBeEditable(computed({ editable: 'yes' }))).toThrow(
      vexpect.objectContaining({ ...invalidArgument, message: 'expect.toBeEditable option editable must be a boolean' }),
    );
    vexpect(() => at('field').toBeEditable(computed({ enabled: true }))).toThrow(
      vexpect.objectContaining({
        ...invalidArgument,
        message: vexpect.stringContaining('expect.toBeEditable options has no key "enabled"'),
      }),
    );
  });
});
