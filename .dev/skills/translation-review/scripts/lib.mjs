/**
 * Shared helpers for the translation skills: where the docs live, how a page
 * splits into sections, what counts as prose, and how `Terms.md` parses.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs');
const NOT_LOCALES = new Set(['images', 'snippets', 'examples', 'node_modules']);
const FENCE = /^ *(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,4}\s+\S/;

/** The locale folders under `docs/`: those with a `navigation.json` or a `Terms.md`. */
export function locales() {
  return readdirSync(DOCS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_LOCALES.has(entry.name) && (existsSync(join(DOCS, entry.name, 'navigation.json')) || existsSync(join(DOCS, entry.name, 'Terms.md'))))
    .map((entry) => entry.name);
}

/** Every `.mdx` page under a folder, relative to it with `/` separators. */
export function pagesUnder(root, base = '') {
  return readdirSync(join(root, base), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) return pagesUnder(root, path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

/** A file's text with LF line endings. */
export function read(path) {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/** Splits a page into sections at h1-h4 headings outside code fences. */
export function sections(source) {
  const out = [];
  let cur = { heading: 'Frontmatter and intro', lines: [] };
  let fence;
  for (const line of source.split('\n')) {
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
export function withoutCode(lines) {
  const out = [];
  let fence;
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

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const CJK_OR_WORD = new RegExp(String.raw`[${CJK}]|(?:(?![${CJK}])[\p{L}\p{N}])+`, 'gu');
const TEXT_ATTRIBUTES =/\b(?:title|subtitle|description|label|aria-label)="([^"]*)"/g;

/**
 * The text a reader reads in a section: frontmatter title and description,
 * attribute text of components, and prose, without code, URLs, link targets,
 * or tags.
 */
export function proseOf(lines) {
  const text = [];
  const body = [];
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
  // A tag may span lines: replace each with the text of its attributes, once.
  const tagless = body.join('\n').replace(/<\/?[A-Za-z][^<>]*>/g, (tag) => ` ${[...tag.matchAll(TEXT_ATTRIBUTES)].map((match) => match[1]).join('\n')} `);
  for (const line of tagless.split('\n')) {
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

/** Words of a text, lowercased; a CJK character counts as one word, since those scripts have no spaces. */
export function words(text) {
  return text.toLowerCase().match(CJK_OR_WORD) ?? [];
}

/** Parses the terms table in `docs/<locale>/Terms.md`: `{ en, forms, note }` per row. */
export function parseTerms(markdown) {
  return markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|')))
    .filter((cells) => cells.length >= 2 && cells[0] !== '' && !/^:?-+:?$/.test(cells[0]) && cells[0].toLowerCase() !== 'english')
    .map(([en, translation, note = '']) => ({ en, forms: translation.split(' / ').map((form) => form.trim()).filter(Boolean), note }));
}

/** The path of a locale's terms file. */
export function termsPath(locale) {
  return join(DOCS, locale, 'Terms.md');
}
