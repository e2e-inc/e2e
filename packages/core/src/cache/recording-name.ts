/**
 * The file name of one test's recordings: what a reviewer sees in a diff's
 * file list, so it says which test it is (`checkout-buys-a-mug`) instead of
 * a digest.
 *
 * The name is the test file's folders below the top one, its name without
 * its last two extensions (`checkout.web.e2e.ts` is `checkout-web`), and the
 * test's titles, from the test id as an entry stores it (redacted), in
 * lowercase ASCII kebab case. Two tests whose names come out the same share
 * no file: the store gives the second the name with `--` and 12 hex
 * characters of its test id's SHA-256 after it (`collisionName`), and each
 * file's lock names the test it holds, so a reader opens the one that is its
 * own. A name that leaves part of the test out (letters or digits outside
 * ASCII, or a name cut short) would collide with the file's other such
 * tests, which of them records first deciding who has the bare name, so it
 * carries the suffix from the start.
 */

import { sha256Hex, STANDALONE_TEST_ID_PREFIX } from '../internal/ids.ts';

/** Longest a name runs before it is cut at a word boundary. */
const MAX_NAME_CHARS = 80;

/** Hex characters of the test id's digest a colliding name carries. */
const COLLISION_DIGEST_CHARS = 12;

/** Names Windows reserves for devices, which no file may take, whatever its extension. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;

/** The shape of every name the store writes: lowercase words joined by single dashes, maybe a collision suffix. */
export const RECORDING_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-f0-9]{12})?$/u;

/** Text as lowercase ASCII words joined by single dashes; accents are dropped, every other character separates words. */
function kebab(text: string): string {
  return text
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
}

/** Whether `kebab` leaves out letters or digits of the text: any but ASCII's, which a name cannot spell. */
function dropsWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.normalize('NFKD').replaceAll(/\p{M}/gu, '').replaceAll(/[a-z0-9]/giu, ''));
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** What a setup test's id puts before the id a test of its file and titles would have (`setupTestId`). */
const SETUP_PREFIX = 'setup::';

/**
 * A test id read back into its file and decoded titles (`collect/`'s
 * `<file>::<title>::...`), and whether it is a setup test's. An id with no
 * titles, such as a `createAgent` recording's `core:<cacheKey>`, is all
 * `file`-less text, in `titles` alone.
 */
export function readTestId(testId: string): { readonly file?: string; readonly titles: readonly string[]; readonly setup: boolean } {
  // A createAgent cache key is whatever text its caller chose, `::` and `%` included.
  if (testId.startsWith(STANDALONE_TEST_ID_PREFIX)) return { titles: [testId], setup: false };
  const setup = testId.startsWith(SETUP_PREFIX);
  const parts = (setup ? testId.slice(SETUP_PREFIX.length) : testId).split('::');
  if (parts.length < 2) return { titles: [testId], setup: false };
  const [file, ...titles] = parts;
  return { file: file!, titles: titles.map(decode), setup };
}

/**
 * The name of a test's recordings, from its test id
 * (`tests/checkout.e2e.ts::buys%20a%20mug` is `checkout-buys-a-mug`). A
 * first title that only repeats the file's stem
 * (`control-inventory.e2e.ts::control inventory::...`) is left out, and a
 * setup test's name ends in `setup`.
 */
export function recordingName(testId: string): string {
  const { file, titles, setup } = readTestId(testId);
  let words: string[];
  let partial = false;
  if (file === undefined) {
    words = [kebab(testId)];
    partial = dropsWords(testId);
  } else {
    // The folders under the top one (`tests/`, which every test of a project shares) tell apart
    // `tests/admin/login.e2e.ts` and `tests/shop/login.e2e.ts`.
    const folders = file.split('/').slice(1, -1);
    const base = file.split('/').pop() ?? '';
    // The file name without its kind and language (`.e2e.ts`): `checkout.web.e2e.ts` is `checkout-web`.
    const segments = base.split('.');
    const stem = kebab(segments.slice(0, segments.length > 2 ? -2 : segments.length > 1 ? -1 : undefined).join('.'));
    const named = titles.map(kebab);
    partial = [...folders, base, ...titles].some(dropsWords);
    words = [...folders.map(kebab), stem, ...(named[0] === stem ? named.slice(1) : named), ...(setup ? ['setup'] : [])];
  }
  let name = words.filter((word) => word !== '').join('-');
  if (name.length > MAX_NAME_CHARS) {
    const cut = name.lastIndexOf('-', MAX_NAME_CHARS);
    name = name.slice(0, cut > 0 ? cut : MAX_NAME_CHARS).replace(/-+$/u, '');
    partial = true;
  }
  if (name === '') name = 'test';
  else if (WINDOWS_DEVICE.test(name)) name = `test-${name}`;
  return partial ? collisionName(name, testId) : name;
}

/** The name a test takes when another test already holds `name`; a name that carries the test's suffix already is its own. */
export function collisionName(name: string, testId: string): string {
  const suffix = `--${sha256Hex(testId).slice(0, COLLISION_DIGEST_CHARS)}`;
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}
