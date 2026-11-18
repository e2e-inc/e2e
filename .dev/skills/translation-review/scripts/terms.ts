/**
 * Edits a locale's `docs/<locale>/Terms.md`.
 *
 * Usage:
 *   node terms.ts list <locale>
 *   node terms.ts init <locale> "<Language>"
 *   node terms.ts add <locale> "<english>" "<translation>" [--note "<why>"]
 *
 * `init` creates the file with its table header, for a locale that has none
 * and keeps no glossary table in its README (ja and zh keep theirs there, read
 * by the DeepL check). `add` inserts a row, keeping the table sorted by English
 * term, or replaces the forms of a row that exists and says so: pass every
 * accepted form to keep. Several accepted forms are written `one / two`, the
 * preferred first.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS, locales, parseTerms, read, termsPath, upsertTerm } from './lib.ts';

const USAGE = `usage: node terms.ts list <locale> | init <locale> "<Language>" | add <locale> "<english>" "<translation>" [--note "<why>"]\nlocales: ${locales().join(', ')}`;
const argv = process.argv.slice(2);
let note: string | undefined;
const joined = argv.findIndex((arg) => arg.startsWith('--note='));
if (joined !== -1) argv.splice(joined, 1, '--note', (argv[joined] ?? '').slice('--note='.length));
const noteAt = argv.indexOf('--note');
if (noteAt !== -1) {
  note = argv[noteAt + 1];
  if (note === undefined || note.startsWith('--')) {
    console.error(`--note needs a value\n${USAGE}`);
    process.exit(2);
  }
  argv.splice(noteAt, 2);
}
const unknownOption = argv.find((arg) => arg.startsWith('--'));
if (unknownOption) {
  console.error(`unknown option ${unknownOption}
${USAGE}`);
  process.exit(2);
}
const [command, locale, rawEnglish, rawTranslation] = argv;
const english = rawEnglish?.trim();
const translation = rawTranslation?.trim();

if (!locale || !locales().includes(locale) || !['list', 'add', 'init'].includes(command ?? '') || (command === 'add' && (!english || !translation)) || (command === 'init' && !english)) {
  console.error(USAGE);
  process.exit(2);
}

if (command === 'init') {
  const readme = join(DOCS, locale, 'README.md');
  if (existsSync(termsPath(locale))) {
    console.error(`docs/${locale}/Terms.md already exists`);
    process.exit(2);
  }
  if (existsSync(readme) && read(readme).split('\n').filter((line) => line.trim().startsWith('|')).length > 3) {
    console.error(`docs/${locale}/README.md already holds a glossary table, which scripts/deepl-review.ts reads. A second glossary would drift: move that table first.`);
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
  if (command === 'list') {
    console.log(`docs/${locale}/Terms.md does not exist: no terms yet`);
    process.exit(0);
  }
  console.error(`docs/${locale}/Terms.md does not exist${command === 'add' ? '; for a locale with no glossary yet, create it with: node terms.ts init <locale> "<Language>"' : ''}`);
  process.exit(2);
}
const source = read(termsPath(locale));

if (command === 'list') {
  for (const term of parseTerms(source)) console.log(`${term.en} -> ${term.forms.join(' / ')}${term.note ? `  (${term.note})` : ''}`);
  process.exit(0);
}

try {
  const result = upsertTerm(source, english ?? '', translation ?? '', note);
  writeFileSync(termsPath(locale), result.text);
  console.log(result.message);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
