/**
 * Checks a docs translation for missing content and for terms that drifted
 * from `docs/<locale>/Terms.md`. It works for any locale folder, including
 * those the docs checks do not register; it compares what is inside each
 * section, and with `--page` it reviews only that page.
 *
 * Usage: node review.mjs <locale> [--page ci.mdx] [--json]
 *
 * Exits 1 when there is an error (content missing); warnings never fail it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS, locales, pagesUnder, parseTerms, proseOf, read, sections, termsPath, withoutCode, words } from './lib.mjs';

/** Pages the first PR of a locale must carry, from the umbrella issue. */
const MINIMUM = ['index', 'quickstart', 'core-concepts', 'agentic-vs-deterministic', 'coding-agents', 'mcp-server', 'ci', 'web', 'mobile'].map((name) => `${name}.mdx`);
const LONG_SECTION = 25;

const args = process.argv.slice(2);
const locale = args.find((arg) => !arg.startsWith('--'));
const pageOption = args.includes('--page') ? args[args.indexOf('--page') + 1] : undefined;
const asJson = args.includes('--json');
if (!locale || !locales().includes(locale)) {
  console.error(`usage: node review.mjs <locale> [--page <page>.mdx] [--json]\nlocales: ${locales().join(', ')}`);
  process.exit(2);
}

/** Counts the items of a list into a map. */
function tally(items) {
  const map = new Map();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

/** Entries of `a` that `b` holds fewer times, as `item (a vs b)`. */
function shortfall(a, b) {
  return [...a].filter(([item, count]) => (b.get(item) ?? 0) < count).map(([item, count]) => `${item} (${count} vs ${b.get(item) ?? 0})`);
}

/** What a section holds that a translation must keep one for one. */
function inventory(lines) {
  const prose = withoutCode(lines);
  const text = prose.join('\n').replace(/export const \w+ = `[\s\S]*?`;/, '');
  return {
    links: tally([...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g), ...text.matchAll(/\bhref="([^"]+)"/g)].map((m) => m[1])),
    codeSpans: tally([...text.replaceAll(String.raw`\``, "'").matchAll(/`([^`]+)`/g)].map((m) => m[1])),
    tags: tally([...text.matchAll(/<\/?([A-Z][A-Za-z]*)\b/g)].map((m) => m[1])),
    listItems: prose.filter((line) => /^\s*([-*]|\d+\.)\s+\S/.test(line)).length,
    tableRows: prose.filter((line) => /^\s*\|/.test(line)).length,
    codeBlocks: lines.filter((line) => /^ *(`{3,}|~{3,})/.test(line)).length,
  };
}

/** A term as pattern text: syntax characters escaped, and a space or hyphen standing for each other ("sign in" matches "sign-in"). */
function escapeTerm(term) {
  return term
    .split(/[\s-]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join(String.raw`[\s-]+`);
}

/** The term as a pattern that also takes a regular plural. */
function termPattern(term) {
  const escaped = escapeTerm(term);
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${escaped}(?:s|es)?(?![\p{L}\p{N}])`, 'iu');
}

/** Whether the text holds a form, as a word start so plurals and verb endings match. */
function hasForm(text, form) {
  const escaped = escapeTerm(form);
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${escaped}`, 'iu').test(text);
}

const terms = existsSync(termsPath(locale)) ? parseTerms(read(termsPath(locale))) : [];
const englishPages = pagesUnder(DOCS).filter((page) => !locales().includes(page.split('/')[0]));
const translatedPages = new Set(pagesUnder(join(DOCS, locale)));
const findings = [];

/** Records a finding. */
function report(page, section, severity, kind, message) {
  findings.push({ page, section, severity, kind, message });
}

if (!pageOption) {
  for (const page of MINIMUM.filter((name) => !translatedPages.has(name))) {
    report(page, '', 'error', 'missing-page', 'in the minimum set but not translated');
  }
}

for (const page of pageOption ? [pageOption] : [...translatedPages].toSorted()) {
  if (!translatedPages.has(page) || !englishPages.includes(page)) {
    report(page, '', 'error', 'bad-page', 'not a translated page of an English page');
    continue;
  }
  const en = sections(read(join(DOCS, page)));
  const tr = sections(read(join(DOCS, locale, page)));
  if (en.length !== tr.length) report(page, '', 'error', 'outline', `${en.length} English sections, ${tr.length} translated`);
  for (let i = 0; i < Math.min(en.length, tr.length); i++) {
    const [a, b] = [en[i], tr[i]];
    const name = i === 0 ? 'intro' : a.heading;
    const [ia, ib] = [inventory(a.lines), inventory(b.lines)];
    for (const [kind, label] of [['links', 'link target'], ['codeSpans', 'inline code'], ['tags', 'component']]) {
      const missing = shortfall(ia[kind], ib[kind]);
      if (missing.length > 0) report(page, name, kind === 'codeSpans' ? 'warning' : 'error', `missing-${kind}`, `${label} missing: ${missing.slice(0, 5).join(', ')}`);
    }
    for (const kind of ['listItems', 'tableRows', 'codeBlocks']) {
      if (ia[kind] !== ib[kind]) report(page, name, 'error', `count-${kind}`, `${kind}: ${ia[kind]} in English, ${ib[kind]} translated`);
    }
    const [textA, textB] = [proseOf(a.lines), proseOf(b.lines)];
    const [wordsA, wordsB] = [words(textA), words(textB)];
    if (wordsA.length >= LONG_SECTION) {
      const ratio = wordsB.length / wordsA.length;
      if (ratio < 0.7) report(page, name, 'error', 'short', `translation has ${wordsB.length} words against ${wordsA.length}: content may be missing`);
      else if (ratio > 1.9) report(page, name, 'warning', 'long', `translation has ${wordsB.length} words against ${wordsA.length}: content may be added`);
      const shared = new Set(wordsA.filter((word) => word.length > 2 && new Set(wordsB).has(word)));
      if (shared.size / new Set(wordsA.filter((word) => word.length > 2)).size > 0.8) report(page, name, 'error', 'untranslated', 'prose looks left in English');
    } else if (wordsA.length > 0 && wordsB.length === 0) {
      report(page, name, 'error', 'empty', 'English has prose, the translation none');
    }
    for (const term of terms) {
      if (termPattern(term.en).test(textA) && !term.forms.some((form) => hasForm(textB, form))) {
        report(page, name, 'warning', 'term', `"${term.en}" should read "${term.forms.join('" or "')}"`);
      }
    }
  }
}

const errors = findings.filter((finding) => finding.severity === 'error').length;
if (asJson) {
  console.log(JSON.stringify({ locale, terms: terms.length, findings }, null, 2));
} else {
  console.log(`${locale}: ${translatedPages.size} of ${englishPages.length} pages translated, ${terms.length} terms${terms.length === 0 ? ' (no Terms.md yet)' : ''}`);
  let current = '';
  for (const finding of findings.toSorted((a, b) => a.page.localeCompare(b.page))) {
    if (finding.page !== current) {
      current = finding.page;
      console.log(`\n${current}`);
    }
    console.log(`  ${finding.severity.toUpperCase().padEnd(7)} ${finding.section ? `[${finding.section}] ` : ''}${finding.message}`);
  }
  console.log(`\n${errors} errors, ${findings.length - errors} warnings`);
}
process.exit(errors > 0 ? 1 : 0);
