/**
 * Edits a locale's `docs/<locale>/Terms.md`.
 *
 * Usage:
 *   node terms.mjs list <locale>
 *   node terms.mjs init <locale> "<Language>"
 *   node terms.mjs add <locale> "<english>" "<translation>" [--note "<why>"]
 *
 * `init` creates the file with its table header, for a locale that has none.
 * `add` inserts a row, keeping the table sorted by English term, or replaces
 * the forms of a row that exists and says so: pass every accepted form to
 * keep. Several accepted forms are written `one / two`, the preferred first.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { locales, parseTerms, read, termsPath } from './lib.mjs';

const USAGE = `usage: node terms.mjs list <locale> | init <locale> "<Language>" | add <locale> "<english>" "<translation>" [--note "<why>"]\nlocales: ${locales().join(', ')}`;
const argv = process.argv.slice(2);
let note;
const noteAt = argv.indexOf('--note');
if (noteAt !== -1) {
  note = argv[noteAt + 1];
  if (note === undefined || note.startsWith('--')) {
    console.error(`--note needs a value\n${USAGE}`);
    process.exit(2);
  }
  argv.splice(noteAt, 2);
}
const [command, locale, english, translation] = argv;

if (!locale || !locales().includes(locale) || !['list', 'add', 'init'].includes(command ?? '') || (command === 'add' && (!english || !translation)) || (command === 'init' && !english)) {
  console.error(USAGE);
  process.exit(2);
}

/** A table cell with pipes escaped. */
const cell = (text) => text.replaceAll('|', String.raw`\|`);

if (command === 'init') {
  if (existsSync(termsPath(locale))) {
    console.error(`docs/${locale}/Terms.md already exists`);
    process.exit(2);
  }
  writeFileSync(
    termsPath(locale),
    `# Terms\n\nHow each technical term is written in ${english}, the same on every page and with any translation engine. When an English section uses a term of this table, the translation uses one of its forms.\n\n- One row per term. The second column takes several forms separated by \` / \`: the plural, the verb forms. The first is preferred.\n- A form matches as the start of a word, ignoring case.\n- A term kept in English repeats itself in the second column.\n- To add or change a row, edit the table and keep it sorted by the first column.\n\n| English | ${english} | Notes |\n| --- | --- | --- |\n`,
  );
  console.log(`created docs/${locale}/Terms.md`);
  process.exit(0);
}
if (!existsSync(termsPath(locale))) {
  console.error(`docs/${locale}/Terms.md does not exist; create it with: node terms.mjs init ${locale} "<Language>"`);
  process.exit(2);
}
const source = read(termsPath(locale));

if (command === 'list') {
  for (const term of parseTerms(source)) console.log(`${term.en} -> ${term.forms.join(' / ')}${term.note ? `  (${term.note})` : ''}`);
  process.exit(0);
}

const lines = source.split('\n');
const first = lines.findIndex((line) => line.trim().startsWith('|'));
let last = first;
while (last + 1 < lines.length && lines[last + 1].trim().startsWith('|')) last++;
if (first === -1) {
  console.error('Terms.md has no table');
  process.exit(2);
}
const header = lines.slice(first, first + 2);
const rows = parseTerms(lines.slice(first, last + 1).join('\n'));
if (rows.length !== last - first - 1) {
  console.error(`Terms.md: ${last - first - 1} table rows but ${rows.length} parsed; fix the table by hand first, so no row is dropped`);
  process.exit(2);
}
const existing = rows.find((row) => row.en.toLowerCase() === english.toLowerCase());
if (existing) {
  console.log(`updated "${existing.en}": ${existing.forms.join(' / ')} -> ${translation}`);
  existing.forms = translation.split(' / ').map((form) => form.trim()).filter(Boolean);
  if (note !== undefined) existing.note = note;
} else {
  rows.push({ en: english, forms: translation.split(' / ').map((form) => form.trim()).filter(Boolean), note: note ?? '' });
  console.log(`added "${english}" -> ${translation}`);
}
const body = rows
  .toSorted((a, b) => a.en.localeCompare(b.en, 'en', { sensitivity: 'base' }))
  .map((row) => `| ${cell(row.en)} | ${cell(row.forms.join(' / '))} | ${cell(row.note)} |`);
writeFileSync(termsPath(locale), [...lines.slice(0, first), ...header, ...body, ...lines.slice(last + 1)].join('\n'));
