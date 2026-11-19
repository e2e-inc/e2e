/**
 * `setInputFiles` against a real page, for both callers the engine acts for,
 * a test's step and the agent: a file input and a label for one take the files without a
 * click, a button that opens a hidden input's chooser is clicked and the
 * chooser takes them, an empty list clears either, two files for an input
 * that takes one are refused as never sent, and a button that opens nothing
 * fails.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KINDS, targetOf, type Target } from '../helpers/action-target.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let session: WebSession;
let file: string;

beforeAll(async () => {
  session = await startWebSession({ startAttempt: false });
  file = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-upload-')), 'avatar.png');
  writeFileSync(file, 'png');
});

afterAll(async () => {
  await session.close();
  rmSync(path.dirname(file), { recursive: true, force: true });
});

beforeEach(async () => {
  await session.startAttempt();
});

/** Uploads `paths`, the fixture file by default, and returns the contract error it failed with, as the engine reports it. */
async function upload(target: Target, paths: readonly string[] = [file]): Promise<Error | undefined> {
  try {
    await session.engine.perform!(target.ref, { kind: 'setInputFiles', paths }, { ...session.op(2_000), origin: target.origin });
    return undefined;
  } catch (cause) {
    return cause as Error;
  }
}

/** The page's record of the file the input holds and the clicks it saw. */
function state(): Promise<{ files: string; clicks: number }> {
  return session.browser.evaluate(() => ({
    files: Array.from(document.querySelector<HTMLInputElement>('#avatar')!.files ?? [], (picked) => picked.name).join(', '),
    clicks: (window as unknown as { clicks: number }).clicks,
  }));
}

const COUNT_CLICKS = '<script>window.clicks = 0; document.addEventListener("click", () => window.clicks++, true)</script>';

describe.each(KINDS)('for the %s', (kind) => {
  it('sets a file input directly', async () => {
    await session.setContent(`<input id="avatar" type="file">${COUNT_CLICKS}`);
    expect(await upload(await targetOf(session, kind, '#avatar'))).toBeUndefined();
    expect(await state()).toEqual({ files: 'avatar.png', clicks: 0 });
  });

  it('sets the input a label names without clicking the label', async () => {
    await session.setContent(`<label id="pick" for="avatar">Choose avatar</label><input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    expect(await upload(await targetOf(session, kind, '#pick'))).toBeUndefined();
    expect(await state()).toEqual({ files: 'avatar.png', clicks: 0 });
  });

  it('clicks a button over a hidden input and sets the files through its chooser', async () => {
    await session.setContent(`
      <button id="pick" type="button" onclick="document.getElementById('avatar').click()">Choose avatar</button>
      <input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    expect(await upload(await targetOf(session, kind, '#pick'))).toBeUndefined();
    expect((await state()).files).toBe('avatar.png');
  });

  it.for([
    ['a file input', '<input id="avatar" type="file">', '#avatar'],
    ['a button over a hidden input', `<button id="pick" type="button" onclick="document.getElementById('avatar').click()">Choose avatar</button><input id="avatar" type="file" hidden>`, '#pick'],
  ] as const)('clears %s with an empty list and fires input and change', async ([_name, html, selector]) => {
    await session.setContent(`${html}${COUNT_CLICKS}`);
    expect(await upload(await targetOf(session, kind, selector))).toBeUndefined();
    await session.browser.evaluate(() => {
      const events: string[] = [];
      (window as unknown as { events: string[] }).events = events;
      const input = document.querySelector('#avatar')!;
      input.addEventListener('input', () => events.push('input'));
      input.addEventListener('change', () => events.push('change'));
      return null;
    });
    expect(await upload(await targetOf(session, kind, selector), [])).toBeUndefined();
    expect((await state()).files).toBe('');
    expect(await session.browser.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(['input', 'change']);
  });

  it('refuses two files for an input that takes one before anything is sent, and changes nothing', async () => {
    await session.setContent(`<input id="avatar" type="file">${COUNT_CLICKS}`);
    const error = await upload(await targetOf(session, kind, '#avatar'), [file, file]);
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'Non-multiple file input can only accept single file' });
    expect((await state()).files).toBe('');
  });

  it('fails when the button opens no file chooser', async () => {
    await session.setContent(`<button id="pick" type="button">Choose avatar</button><input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    const error = await upload(await targetOf(session, kind, '#pick'));
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('opened no file chooser') });
    expect((await state()).files).toBe('');
  });
});
