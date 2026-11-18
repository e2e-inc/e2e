/**
 * What the translation skills share, so the review, the `Terms.md` editor, the
 * `terms-find` script, and the viewer server cannot disagree: where the docs
 * live, how a page splits into sections, what counts as prose, how `Terms.md`
 * parses, and how a term is matched.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pages } from '../../../../scripts/docs-pages.ts';

export const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs');
const NOT_LOCALES = new Set(['images', 'snippets', 'examples', 'node_modules']);
const FENCE = /^ *(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,4}\s+\S/;

/** One heading section of a page: its heading line and every line, code included. */
export interface Section {
  heading: string;
  lines: string[];
}

/** One row of a locale's `Terms.md`. */
export interface Term {
  en: string;
  forms: string[];
  note: string;
}

/** One thing a review found: where, how bad, what kind, and a sentence for a person. */
export interface Finding {
  page: string;
  section: string;
  severity: 'error' | 'warning';
  kind: string;
  message: string;
}

/** The locale folders under `docs/`: those with a `navigation.json` or a `Terms.md`. */
export function locales(): string[] {
  return readdirSync(DOCS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_LOCALES.has(entry.name) && (existsSync(join(DOCS, entry.name, 'navigation.json')) || existsSync(join(DOCS, entry.name, 'Terms.md'))))
    .map((entry) => entry.name);
}

/** Every `.mdx` page under a folder, relative to it with `/` separators (the walker the docs checks use). */
export function pagesUnder(root: string): string[] {
  return pages(root).map((page) => relative(root, page).replaceAll('\\', '/'));
}

/** A file's text with LF line endings. */
export function read(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/** Splits a page into sections at h1-h4 headings outside code fences. */
export function sections(source: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { heading: 'Frontmatter and intro', lines: [] };
  let fence: string | undefined;
  for (const line of source.replaceAll('\r\n', '\n').split('\n')) {
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
    } else if (mark) {
      fence = mark;
    } else if (HEADING.test(line)) {
      out.push(cur);
      cur = { heading: line.trim(), lines: [] };
    }
    cur.lines.push(line);
  }
  out.push(cur);
  return out;
}

/** The section's lines without fenced code blocks (fence lines included). */
export function withoutCode(lines: string[]): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
    } else if (mark) {
      fence = mark;
    } else {
      out.push(line);
    }
  }
  return out;
}

const TEXT_ATTRIBUTES = /\b(?:title|subtitle|description|label|aria-label)="([^"]*)"/g;
const TAG = /<\/?[A-Za-z][^<>]*>/g;

/** A tag replaced by the text of its title, subtitle, description, and label attributes, once, even when it spans lines. */
function tagText(tag: string): string {
  return ` ${[...tag.matchAll(TEXT_ATTRIBUTES)].map((match) => match[1]).join('\n')} `;
}

/**
 * The text a reader reads in a section: frontmatter title and description,
 * attribute text of components, and prose, without code, URLs, link targets,
 * or tags.
 */
export function proseOf(lines: string[]): string {
  const text: string[] = [];
  const body: string[] = [];
  let inFrontmatter = false;
  for (const [index, line] of withoutCode(lines).entries()) {
    if (index === 0 && line === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false;
      else {
        const value = /^(?:title|description|sidebarTitle):\s*(.+)$/.exec(line)?.[1];
        if (value) text.push(value.replace(/^["']|["']$/g, ''));
      }
      continue;
    }
    if (/^\s*(import|export)\s/.test(line)) continue;
    body.push(line);
  }
  for (const line of body.join('\n').replace(TAG, tagText).split('\n')) {
    const stripped = line
      .replace(/`[^`]*`/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/^\s*(#{1,6}|[-*]|\d+\.|>)\s+/, '')
      .replace(/[|*_]/g, ' ')
      .trim();
    if (stripped && !/^[-: ]+$/.test(stripped)) text.push(stripped);
  }
  return text.join('\n');
}

/**
 * The text a model reads for a section: code blocks become `[code block]`,
 * imports, exports, and MDX tags are dropped (a tag's title, subtitle,
 * description, and label text stay). Inline code and link text stay, since a
 * sentence reads wrong without them.
 */
export function modelText(lines: string[]): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
    } else if (mark) {
      fence = mark;
      out.push('[code block]');
    } else if (!/^\s*(import|export)\s/.test(line)) {
      out.push(line);
    }
  }
  return out.join('\n').replace(TAG, tagText).replace(/\n{3,}/g, '\n\n').trim();
}

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const CJK_OR_WORD = new RegExp(String.raw`[${CJK}]|(?:(?![${CJK}])[\p{L}\p{N}])+`, 'gu');
const CJK_CHAR = new RegExp(String.raw`[${CJK}]`, 'u');

/** Words of a text, lowercased; a CJK character counts as one word, since those scripts have no spaces. */
export function words(text: string): string[] {
  return text.toLowerCase().match(CJK_OR_WORD) ?? [];
}

/** The share of a text's letters that are Chinese, Japanese, or Korean. */
export function cjkShare(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const cjk = text.match(new RegExp(String.raw`[${CJK}]`, 'gu'))?.length ?? 0;
  return letters === 0 ? 0 : cjk / letters;
}

/** Parses the terms table in `docs/<locale>/Terms.md`: `{ en, forms, note }` per row. */
export function parseTerms(markdown: string): Term[] {
  return markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|')))
    .filter((cells) => cells.length >= 2 && cells[0] !== '' && !/^:?-+:?$/.test(cells[0] ?? '') && cells[0]?.toLowerCase() !== 'english')
    .map(([en = '', translation = '', note = '']) => ({ en, forms: translation.split(' / ').map((form) => form.trim()).filter(Boolean), note }));
}

/** The path of a locale's terms file. */
export function termsPath(locale: string): string {
  return join(DOCS, locale, 'Terms.md');
}

/** A term as pattern text: syntax characters escaped, and a space or hyphen standing for each other ("sign in" matches "sign-in"). */
function escapeTerm(term: string): string {
  return term
    .split(/[\s-]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join(String.raw`[\s-]+`);
}

/** The English term as a pattern that also takes a regular plural. */
export function termPattern(term: string): RegExp {
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeTerm(term)}(?:s|es)?(?![\p{L}\p{N}])`, 'iu');
}

/**
 * Whether the text holds a form of the translation, as a word start so plurals
 * and verb endings match. A form that starts with a CJK character needs no
 * word start: those scripts have no spaces to start a word at.
 */
export function hasForm(text: string, form: string): boolean {
  const start = CJK_CHAR.test(form.charAt(0)) ? '' : String.raw`(?<![\p{L}\p{N}])`;
  return new RegExp(`${start}${escapeTerm(form)}`, 'iu').test(text);
}

/** The rows of `terms` whose English term occurs in an English text. */
export function termsIn(text: string, terms: Term[]): Term[] {
  return terms.filter((term) => termPattern(term.en).test(text));
}

/** Counts the items of a list into a map. */
function tally(items: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

/** Entries of `a` that `b` holds fewer times, as `item (a vs b)`. */
function shortfall(a: Map<string, number>, b: Map<string, number>): string[] {
  return [...a].filter(([item, count]) => (b.get(item) ?? 0) < count).map(([item, count]) => `${item} (${count} vs ${b.get(item) ?? 0})`);
}

/** What a section holds that a translation must keep one for one. */
export interface Inventory {
  links: Map<string, number>;
  codeSpans: Map<string, number>;
  tags: Map<string, number>;
  listItems: number;
  tableRows: number;
  codeBlocks: number;
}

/** Counts links (Markdown and a component's `href`), inline code, components, list items, table rows, and code blocks. */
export function inventory(lines: string[]): Inventory {
  const prose = withoutCode(lines);
  const text = prose.join('\n').replace(/export const \w+ = `[\s\S]*?`;/, '');
  return {
    links: tally([...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g), ...text.matchAll(/\bhref="([^"]+)"/g)].map((match) => match[1] ?? '')),
    codeSpans: tally([...text.replaceAll(String.raw`\``, "'").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')),
    tags: tally([...text.matchAll(/<\/?([A-Z][A-Za-z]*)\b/g)].map((match) => match[1] ?? '')),
    listItems: prose.filter((line) => /^\s*([-*]|\d+\.)\s+\S/.test(line)).length,
    tableRows: prose.filter((line) => /^\s*\|/.test(line)).length,
    codeBlocks: Math.ceil(lines.filter((line) => FENCE.test(line)).length / 2),
  };
}

/** Prose sections shorter than this many English words get no length or untranslated check. */
const LONG_SECTION = 25;

/**
 * Compares one English section with its translation: what is missing, what
 * was left in English, and which terms of `Terms.md` the translation does not
 * use. The length checks are skipped for Chinese, Japanese, and Korean text,
 * whose character counts have no calibrated ratio to English words yet.
 */
export function reviewSection(page: string, name: string, a: Section, b: Section, terms: Term[]): Finding[] {
  const findings: Finding[] = [];
  const report = (severity: Finding['severity'], kind: string, message: string) => findings.push({ page, section: name, severity, kind, message });
  const [ia, ib] = [inventory(a.lines), inventory(b.lines)];
  const checks: [keyof Pick<Inventory, 'links' | 'codeSpans' | 'tags'>, string][] = [['links', 'link target'], ['codeSpans', 'inline code'], ['tags', 'component']];
  for (const [kind, label] of checks) {
    const missing = shortfall(ia[kind], ib[kind]);
    if (missing.length > 0) report(kind === 'codeSpans' ? 'warning' : 'error', `missing-${kind}`, `${label} missing: ${missing.slice(0, 5).join(', ')}`);
  }
  for (const kind of ['listItems', 'tableRows', 'codeBlocks'] as const) {
    if (ia[kind] !== ib[kind]) report('error', `count-${kind}`, `${kind}: ${ia[kind]} in English, ${ib[kind]} translated`);
  }
  const [textA, textB] = [proseOf(a.lines), proseOf(b.lines)];
  const [wordsA, wordsB] = [words(textA), words(textB)];
  if (wordsA.length >= LONG_SECTION) {
    if (cjkShare(textB) <= 0.3) {
      const ratio = wordsB.length / wordsA.length;
      if (ratio < 0.7) report('error', 'short', `translation has ${wordsB.length} words against ${wordsA.length}: content may be missing`);
      else if (ratio > 1.9) report('warning', 'long', `translation has ${wordsB.length} words against ${wordsA.length}: content may be added`);
    }
    const translated = new Set(wordsB);
    const long = new Set(wordsA.filter((word) => word.length > 2));
    const shared = [...long].filter((word) => translated.has(word));
    if (long.size > 0 && shared.length / long.size > 0.8) report('error', 'untranslated', 'prose looks left in English');
  } else if (wordsA.length > 0 && wordsB.length === 0) {
    report('error', 'empty', 'English has prose, the translation none');
  }
  for (const term of termsIn(textA, terms)) {
    if (!term.forms.some((form) => hasForm(textB, form))) report('warning', 'term', `"${term.en}" should read "${term.forms.join('" or "')}"`);
  }
  return findings;
}

/**
 * Adds a row to a `Terms.md` table, keeping it sorted by English term, or
 * replaces the forms of the row that exists. Refuses when the table has a row
 * the parser would drop, so no row is lost.
 */
export function upsertTerm(source: string, english: string, translation: string, note?: string): { text: string; message: string } {
  const lines = source.split('\n');
  const first = lines.findIndex((line) => line.trim().startsWith('|'));
  if (first === -1) throw new Error('Terms.md has no table');
  let last = first;
  while (last + 1 < lines.length && lines[last + 1]?.trim().startsWith('|')) last++;
  const rows = parseTerms(lines.slice(first, last + 1).join('\n'));
  if (rows.length !== last - first - 1) {
    throw new Error(`Terms.md: ${last - first - 1} table rows but ${rows.length} parsed; fix the table by hand first, so no row is dropped`);
  }
  const forms = translation.split(' / ').map((form) => form.trim()).filter(Boolean);
  const existing = rows.find((row) => row.en.toLowerCase() === english.toLowerCase());
  let message: string;
  if (existing) {
    message = `updated "${existing.en}": ${existing.forms.join(' / ')} -> ${translation}`;
    existing.forms = forms;
    if (note !== undefined) existing.note = note;
  } else {
    rows.push({ en: english, forms, note: note ?? '' });
    message = `added "${english}" -> ${translation}`;
  }
  const cell = (text: string) => text.replaceAll('|', String.raw`\|`);
  const body = rows
    .toSorted((a, b) => a.en.localeCompare(b.en, 'en', { sensitivity: 'base' }))
    .map((row) => `| ${cell(row.en)} | ${cell(row.forms.join(' / '))} | ${cell(row.note)} |`);
  return { text: [...lines.slice(0, first), ...lines.slice(first, first + 2), ...body, ...lines.slice(last + 1)].join('\n'), message };
}
