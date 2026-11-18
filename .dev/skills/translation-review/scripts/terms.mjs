/**
 * Edits a locale's `docs/<locale>/Terms.md`.
 *
 * Usage:
 *   node terms.mjs list <locale>
 *   node terms.mjs add <locale> "<english>" "<translation>" [--note "<why>"]
 *
 * `add` inserts a row, keeping the table sorted by English term, or replaces
 * the translation of a row that exists and says so. Several accepted
 * translations are written `one / two`.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { locales, parseTerms, read, termsPath } from './lib.mjs';

const [command, locale, english, translation] = process.argv.slice(2);
const noteAt = process.argv.indexOf('--note');
const note = noteAt === -1 ? undefined : process.argv[noteAt + 1];

if (!locale || !locales().includes(locale) || !['list', 'add'].includes(command ?? '') || (command === 'add' && (!english || !translation))) {
  console.error(`usage: node terms.mjs list <locale> | add <locale> "<english>" "<translation>" [--note "<why>"]\nlocales: ${locales().join(', ')}`);
  process.exit(2);
}
if (!existsSync(termsPath(locale))) {
  console.error(`docs/${locale}/Terms.md does not exist; create it with the table header first`);
  process.exit(2);
}

/** A table cell with pipes escaped. */
const cell = (text) => text.replaceAll('|', String.raw`\|`);
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
const existing = rows.find((row) => row.en.toLowerCase() === english.toLowerCase());
if (existing) {
  console.log(`updated "${existing.en}": ${existing.forms.join(' / ')} -> ${translation}`);
  existing.forms = [translation];
  if (note !== undefined) existing.note = note;
} else {
  rows.push({ en: english, forms: [translation], note: note ?? '' });
  console.log(`added "${english}" -> ${translation}`);
}
const body = rows
  .toSorted((a, b) => a.en.localeCompare(b.en, 'en', { sensitivity: 'base' }))
  .map((row) => `| ${cell(row.en)} | ${cell(row.forms.join(' / '))} | ${cell(row.note)} |`);
writeFileSync(termsPath(locale), [...lines.slice(0, first), ...header, ...body, ...lines.slice(last + 1)].join('\n'));
