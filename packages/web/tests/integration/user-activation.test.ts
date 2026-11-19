/**
 * The edits a test makes for the user count as the user's gesture in the
 * page, as the keys and clicks a person would make them with do: a page that
 * was only filled in may then ask to confirm leaving, open a window or write
 * the clipboard.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocatorAction } from '@e2e-dev/core/engine';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';

const PAGE = `<title>Form</title>
<input id="name" value="draft">
<select id="size"><option>S</option><option>M</option></select>
<input id="file" type="file">
<script>
  window.seen = [];
  for (const id of ['name', 'size', 'file']) {
    document.getElementById(id).addEventListener(id === 'name' ? 'input' : 'change', () => window.seen.push(navigator.userActivation.isActive));
  }
</script>`;

let session: WebSession;
let dir: string;
let file: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'e2e-activation-'));
  file = path.join(dir, 'notes.txt');
  writeFileSync(file, 'notes');
  session = await startWebSession({ startAttempt: false });
});

afterAll(async () => {
  await session.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await session.startAttempt();
  await session.setContent(PAGE);
});

/** What the page's edit handlers saw of the user's activation, and whether the document was ever activated. */
function activation(): Promise<{ seen: boolean[]; hasBeenActive: boolean }> {
  return session.browser.evaluate(() => ({ seen: (window as unknown as { seen: boolean[] }).seen, hasBeenActive: navigator.userActivation.hasBeenActive }));
}

describe('user activation', () => {
  it('is not given by opening a page or reading it', async () => {
    await session.locate(bySelector('#name'));
    expect(await activation()).toEqual({ seen: [], hasBeenActive: false });
  });

  const edits: readonly (readonly [string, string, () => LocatorAction])[] = [
    ['fill', '#name', () => ({ kind: 'fill', value: 'edited', sensitive: false })],
    ['clear', '#name', () => ({ kind: 'clear' })],
    ['selectOption', '#size', () => ({ kind: 'selectOption', value: 'M' })],
    ['setInputFiles', '#file', () => ({ kind: 'setInputFiles', paths: [file] })],
  ];
  for (const [name, selector, action] of edits) {
    it(`${name} is the user's gesture to the page`, async () => {
      await session.act(bySelector(selector), action());
      expect(await activation()).toEqual({ seen: [true], hasBeenActive: true });
    });
  }
});
