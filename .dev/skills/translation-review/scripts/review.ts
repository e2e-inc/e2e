/**
 * Checks a docs translation for missing content and for terms that drifted
 * from `docs/<locale>/Terms.md`. It works for any locale folder, including
 * those the docs checks do not register; it compares what is inside each
 * section.
 *
 * Usage: node review.ts <locale> [--page ci.mdx] [--minimum] [--json]
 *
 * `--page` reviews only that page. `--minimum` also requires the pages the
 * first PR of a locale carries (issue #1890). Exits 1 when there is an error
 * (content missing); warnings never fail it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS, locales, pagesUnder, parseTerms, read, reviewSection, sections, termsPath } from './lib.ts';
import type { Finding } from './lib.ts';

/** Pages the first PR of a locale must carry, from the umbrella issue. */
const MINIMUM = ['index', 'quickstart', 'core-concepts', 'agentic-vs-deterministic', 'coding-agents', 'mcp-server', 'ci', 'web', 'mobile'].map((name) => `${name}.mdx`);

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg.startsWith('--') && !['--page', '--minimum', '--json'].includes(arg));
if (unknown.length > 0) {
  console.error(`unknown option ${unknown.join(', ')}
usage: node review.ts <locale> [--page <page>.mdx] [--minimum] [--json]`);
  process.exit(2);
}
const locale = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--page');
const pageAt = args.indexOf('--page');
const pageOption = pageAt === -1 ? undefined : args[pageAt + 1];
const asJson = args.includes('--json');
const usage = `usage: node review.ts <locale> [--page <page>.mdx] [--minimum] [--json]\nlocales: ${locales().join(', ')}`;
if (!locale || !locales().includes(locale)) {
  console.error(usage);
  process.exit(2);
}
if (pageAt !== -1 && (pageOption === undefined || pageOption.startsWith('--'))) {
  console.error(`--page needs a page, such as ci.mdx\n${usage}`);
  process.exit(2);
}

const terms = existsSync(termsPath(locale)) ? parseTerms(read(termsPath(locale))) : [];
const localeNames = locales();
const englishPages = pagesUnder(DOCS).filter((page) => !localeNames.includes(page.split('/')[0] ?? ''));
const translatedPages = new Set(pagesUnder(join(DOCS, locale)));
const findings: Finding[] = [];

if (args.includes('--minimum') && !pageOption) {
  for (const page of MINIMUM.filter((name) => !translatedPages.has(name))) {
    findings.push({ page, section: '', severity: 'error', kind: 'missing-page', message: 'in the minimum set but not translated' });
  }
}

for (const page of pageOption ? [pageOption] : [...translatedPages].toSorted()) {
  if (!translatedPages.has(page) || !englishPages.includes(page)) {
    findings.push({ page, section: '', severity: 'error', kind: 'bad-page', message: 'not a translated page of an English page' });
    continue;
  }
  const en = sections(read(join(DOCS, page)));
  const tr = sections(read(join(DOCS, locale, page)));
  if (en.length !== tr.length) findings.push({ page, section: '', severity: 'error', kind: 'outline', message: `${en.length} English sections, ${tr.length} translated` });
  for (let i = 0; i < Math.min(en.length, tr.length); i++) {
    const [a, b] = [en[i], tr[i]];
    if (a && b) findings.push(...reviewSection(page, i === 0 ? 'intro' : a.heading, a, b, terms));
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
