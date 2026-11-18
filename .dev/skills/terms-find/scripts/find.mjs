/**
 * Finds how a reference documentation site translates a term: searches the
 * English docs for pages that use it, fetches each page in the target
 * language, pairs the two pages' text blocks by position, and ranks the words
 * and phrases that appear in the translation of the blocks that hold the term.
 *
 * Sources, in order: Microsoft Learn, then MDN Web Docs when Learn has too
 * little evidence (`--source learn|mdn|both` forces one).
 *
 * Usage: node find.mjs <locale> "<english term>" [--source both] [--pages 8] [--samples 4] [--json]
 *
 * Only the search term leaves the machine. Needs network access.
 */

/** Our locale codes (docs/<locale>/) to each source's. MDN translates only some languages. */
const SOURCES = {
  learn: {
    name: 'Microsoft Learn',
    origin: 'https://learn.microsoft.com',
    locales: {
      es: 'es-es', ja: 'ja-jp', zh: 'zh-cn', fr: 'fr-fr', de: 'de-de', 'pt-BR': 'pt-br', ko: 'ko-kr', pl: 'pl-pl',
      cz: 'cs-cz', cs: 'cs-cz', tr: 'tr-tr', hi: 'hi-in', uk: 'uk-ua', it: 'it-it', nl: 'nl-nl', ru: 'ru-ru', sv: 'sv-se',
    },
    searchUrl: (term, top) => `https://learn.microsoft.com/api/search?search=${encodeURIComponent(term)}&locale=en-us&%24top=${top}`,
    urlsOf: (json) => json.results.map((result) => result.url).filter((url) => url.includes('/en-us/')),
    translate: (url, locale) => url.replace('/en-us/', `/${locale}/`),
  },
  mdn: {
    name: 'MDN Web Docs',
    origin: 'https://developer.mozilla.org',
    locales: { es: 'es', ja: 'ja', zh: 'zh-CN', fr: 'fr', ko: 'ko', 'pt-BR': 'pt-BR', ru: 'ru' },
    searchUrl: (term, top) => `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(term)}&locale=en-US&size=${top}`,
    urlsOf: (json) => json.documents.map((doc) => `https://developer.mozilla.org${doc.mdn_url}`),
    translate: (url, locale) => url.replace('/en-US/', `/${locale}/`),
  },
};

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const VALUE_FLAGS = new Set(['--pages', '--samples', '--source']);
const positional = args.filter((arg, i) => !arg.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''));
const [locale, term] = positional;
if (!locale || !term) {
  console.error(`usage: node find.mjs <locale> "<english term>" [--source both|learn|mdn] [--pages 8] [--samples 4] [--json]\nlocales: ${Object.keys(SOURCES.learn.locales).join(', ')} (MDN: ${Object.keys(SOURCES.mdn.locales).join(', ')})`);
  process.exit(2);
}
/** A flag that must be a positive whole number. */
function positiveInt(name, fallback) {
  const value = Number(flag(name, fallback));
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} must be a positive whole number`);
    process.exit(2);
  }
  return value;
}
const pageLimit = positiveInt('pages', '8');
const sampleLimit = positiveInt('samples', '4');
const sourceOption = flag('source', 'both');
const asJson = args.includes('--json');
/** Learn gives too little evidence below this many blocks with the term. */
const ENOUGH = 8;

/** Set when a site answered 429: the caller should wait instead of retrying. */
let rateLimited = false;

/** Fetches a page: its text and final URL, or undefined on a failure. */
async function get(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'terms-find' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) rateLimited = true;
    return res.ok ? { text: await res.text(), url: res.url } : undefined;
  } catch {
    return undefined;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The reading blocks of a page: headings, paragraphs, list items, and table cells of its main content. */
function blocks(html) {
  const main = /<main\b[\s\S]*<\/main>/.exec(html)?.[0] ?? html;
  const body = main.replace(/<(script|style|nav|aside)\b[\s\S]*?<\/\1>/g, '');
  return [...body.matchAll(/<(h[1-6]|p|li|td|th|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/g)]
    .map((match) =>
      match[2]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (all, code) => (code[0] === '#' ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))) : (ENTITIES[code] ?? all)))
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

/** Lowercase words of a block. */
const wordsOf = (text) => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];

/** The word 1-3 grams of a block, as a set. */
function grams(text) {
  const w = wordsOf(text);
  const out = new Set();
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

/** The term as pattern text: syntax characters escaped, a space or hyphen standing for each other ("end-to-end", "sign in"). */
const escaped = term
  .split(/[\s-]+/)
  .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
  .join(String.raw`[\s-]+`);
const termPattern = new RegExp(String.raw`(?<![\p{L}\p{N}])${escaped}(?:s|es)?(?![\p{L}\p{N}])`, 'iu');

/** Runs one source: its pages, the ranked candidates, and the sample pairs. */
async function collect(key) {
  rateLimited = false;
  const source = SOURCES[key];
  const target = source.locales[locale];
  if (!target) return { source: source.name, error: `${source.name} has no ${locale} translation` };
  const search = await get(source.searchUrl(term, pageLimit * 2));
  if (!search) return { source: source.name, error: rateLimited ? `${source.name} answered 429 (rate limited): wait a few minutes, and search fewer terms in a row` : `${source.name} search did not answer; check the network` };
  const urls = [...new Set(source.urlsOf(JSON.parse(search.text)))].slice(0, pageLimit * 3);
  const inTerm = new Map();
  const outside = new Map();
  const samples = [];
  const used = [];
  const skipped = [];
  let termBlocks = 0;
  let otherBlocks = 0;
  for (const url of urls) {
    if (used.length >= pageLimit) break;
    const other = source.translate(url, target);
    const [en, tr] = await Promise.all([get(url), get(other)]);
    if (rateLimited) {
      return { source: source.name, error: `${source.name} answered 429 (rate limited) after ${used.length} pages: wait a few minutes, and search fewer terms in a row. Nothing below is complete evidence.` };
    }
    if (!en || !tr) {
      skipped.push(`${url} (no ${target} page)`);
      continue;
    }
    if (tr.url !== other && !tr.url.includes(`/${target}/`)) {
      skipped.push(`${url} (${target} page falls back to English)`);
      continue;
    }
    const [enBlocks, trBlocks] = [blocks(en.text), blocks(tr.text)];
    if (enBlocks.length !== trBlocks.length) {
      skipped.push(`${url} (blocks differ: ${enBlocks.length} vs ${trBlocks.length})`);
      continue;
    }
    used.push(url);
    enBlocks.forEach((block, i) => {
      const hit = termPattern.test(block);
      for (const gram of grams(trBlocks[i])) {
        const map = hit ? inTerm : outside;
        map.set(gram, (map.get(gram) ?? 0) + 1);
      }
      if (hit) {
        termBlocks++;
        samples.push({ url: other, english: block, translated: trBlocks[i] });
      } else {
        otherBlocks++;
      }
    });
  }
  const candidates = [...inTerm]
    .filter(([gram, count]) => count >= Math.min(2, termBlocks) && gram.length > 2)
    .map(([gram, count]) => ({ gram, blocks: count, lift: Number(((count / Math.max(termBlocks, 1)) / (((outside.get(gram) ?? 0) + 1) / (otherBlocks + 1))).toFixed(1)) }))
    .toSorted((a, b) => b.lift * Math.log2(1 + b.blocks) - a.lift * Math.log2(1 + a.blocks))
    .slice(0, 15);
  return {
    source: source.name,
    learnLocale: target,
    pages: used,
    termBlocks,
    candidates,
    samples: samples.toSorted((a, b) => a.english.length - b.english.length).slice(0, sampleLimit),
    skipped,
  };
}

const order = sourceOption === 'both' ? ['learn', 'mdn'] : [sourceOption];
if (!order.every((key) => key in SOURCES)) {
  console.error('--source is learn, mdn, or both');
  process.exit(2);
}
const results = [];
for (const key of order) {
  const result = await collect(key);
  results.push(result);
  if (sourceOption === 'both' && (result.termBlocks ?? 0) >= ENOUGH) break;
}

if (asJson) {
  console.log(JSON.stringify({ term, locale, results }, null, 2));
} else {
  for (const result of results) {
    if (result.error) {
      console.log(`${result.source}: ${result.error}\n`);
      continue;
    }
    console.log(`${result.source}: "${term}" in ${result.learnLocale}: ${result.termBlocks} blocks with the term, from ${result.pages.length} pages (${result.skipped.length} skipped)`);
    if (result.termBlocks === 0) {
      console.log('  No page used the term; try another spelling or --pages 15.');
    } else {
      console.log('\nCandidates (blocks of the translation, lift against blocks without the term):');
      for (const c of result.candidates) console.log(`  ${c.gram.padEnd(32)} ${String(c.blocks).padStart(3)} blocks  lift ${c.lift}`);
      console.log('\nSamples:');
      for (const s of result.samples) console.log(`  EN: ${s.english.slice(0, 220)}\n  ${locale.toUpperCase()}: ${s.translated.slice(0, 220)}\n  ${s.url}\n`);
    }
    if (result.skipped.length > 0) console.log(`Skipped:\n${result.skipped.slice(0, 6).map((line) => `  ${line}`).join('\n')}\n`);
  }
}
