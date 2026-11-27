import { runInNewContext } from 'node:vm';
import { toTextPattern } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { choiceLabel, chosenWindow, windowChoice, type DesktopWindow, type WindowSource } from '../../src/window-choice.ts';

const signal = new AbortController().signal;

function source(windows: readonly DesktopWindow[]): WindowSource {
  return { app: 'Notes', opened: () => true, list: async () => windows, locked: () => false };
}

describe('windowChoice', () => {
  it('reads a string or a RegExp as a title, and a listed window as its id', () => {
    expect(windowChoice('Controls')).toEqual({ title: toTextPattern('Controls') });
    expect(windowChoice(/^Contr/i)).toEqual({ title: toTextPattern(/^Contr/i) });
    expect(windowChoice({ id: 'w-1', title: 'Controls', focused: true })).toEqual({ id: 'w-1' });
  });

  it('reads a RegExp of another realm as a title', () => {
    expect(windowChoice(runInNewContext('/^Contr/'))).toEqual({ title: toTextPattern(/^Contr/) });
  });

  it('names nothing for no argument, or for one that is neither a title nor a window', () => {
    expect([undefined, null, 42, {}, { id: 42 }].map(windowChoice)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('labels a step by the title, and an id by nothing', () => {
    expect([windowChoice('Controls'), windowChoice(/^Contr/), windowChoice({ id: 'w-1' }), undefined].map(choiceLabel)).toEqual(['"Controls"', '/^Contr/', '', '']);
  });
});

describe('chosenWindow', () => {
  const listed = source([
    { id: 'w-1', title: 'Sign In', focused: true },
    { id: 'w-2', title: ' Find  & Replace ', focused: false },
  ]);

  it('matches a title as screen matches text: whitespace runs are one space, and the ends are trimmed', async () => {
    expect(await chosenWindow({ title: toTextPattern('Find & Replace') }, { signal, timeoutMs: 1_000 }, listed)).toBe('w-2');
    expect(await chosenWindow({ title: toTextPattern(/^Find & Replace$/) }, { signal, timeoutMs: 1_000 }, listed)).toBe('w-2');
  });

  it('takes a string for the whole title, never a part of it', async () => {
    await expect(chosenWindow({ title: toTextPattern('Sign') }, { signal, timeoutMs: 150 }, listed)).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/no window titled "Sign" within 150 ms/) });
  });

  it('picks a listed id with no wait, and refuses one the app does not list', async () => {
    expect(await chosenWindow({ id: 'w-2' }, { signal, timeoutMs: 1_000 }, listed)).toBe('w-2');
    await expect(chosenWindow({ id: 'w-9' }, { signal, timeoutMs: 1_000 }, listed)).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/no window with the id w-9/) });
  });
});
