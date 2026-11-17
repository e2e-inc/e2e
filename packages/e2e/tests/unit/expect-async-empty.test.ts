import { describe, expect as vexpect, it } from 'vitest';
import type { SemanticNode } from '@e2e-dev/core/lib/engine/surface';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { createScreenFixture } from '../helpers/screen-fixture.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

const node = (fields: Omit<SemanticNode, 'ref'>): SemanticNode => ({ ref: { id: 'node-1', revision: '' }, testId: 'it', ...fields });
const at = (fields: Omit<SemanticNode, 'ref'>) => expectFixture(createScreenFixture([node(fields)]).getByTestId('it'));
const soon = { timeout: 500 };

describe('toBeEmpty', () => {
  it('passes on a form control with an empty or unreported value', async () => {
    await at({ role: 'textbox', value: '' }).toBeEmpty();
    await at({ role: 'textbox' }).toBeEmpty();
    await at({ role: 'textbox', value: 'ada' }).not.toBeEmpty();
  });

  it('reads a value as it is, so a space is not empty', async () => {
    await vexpect(at({ role: 'textbox', value: ' ' }).toBeEmpty(soon)).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringContaining('observed: value " "'),
    });
  });

  it('reads any other node by its normalized text', async () => {
    await at({ role: 'generic' }).toBeEmpty();
    await at({ role: 'generic', text: ' \n ' }).toBeEmpty();
    await at({ role: 'list', text: 'Milk' }).not.toBeEmpty();
    await vexpect(at({ role: 'list', text: ' Milk  and eggs ' }).toBeEmpty(soon)).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringMatching(/expected: empty\nobserved: text "Milk and eggs"/),
    });
  });

  it('reads an option by its text, not its value', async () => {
    await at({ role: 'option', text: 'Red' }).not.toBeEmpty();
    await at({ role: 'option', text: 'Choose a colour', value: '' }).not.toBeEmpty();
    await at({ role: 'option' }).toBeEmpty();
  });

  it('fails the negation on an empty node', async () => {
    await vexpect(at({ role: 'textbox', value: '' }).not.toBeEmpty(soon)).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringContaining('expected: not empty'),
    });
  });

  it('refuses to judge a secure field, whose value is withheld, negated or not', async () => {
    const denied = { code: 'POLICY_DENIED', message: 'reading values from a secure field is denied: getByTestId("it")' };
    const secure = { role: 'textbox', name: 'Password', states: { secure: true } };
    await vexpect(at(secure).toBeEmpty()).rejects.toMatchObject(denied);
    await vexpect(at(secure).not.toBeEmpty()).rejects.toMatchObject(denied);
  });
});
