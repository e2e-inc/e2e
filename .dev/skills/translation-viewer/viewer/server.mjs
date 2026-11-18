/**
 * Local server for the translation review viewer: a file tree of one
 * locale's pages, each beside its English source, with a review run in the
 * browser by Chrome's built-in model. No dependencies.
 *
 * Usage: node server.mjs [--locale es] [--port 4777] [--out <dir>]
 *
 * Findings the page posts are written to `<out>/<locale>/<page>.json`, so the
 * agent that started the server can read and apply them.
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, '../../../../docs');
/** Folders under `docs/` that are not locales. */
const NOT_LOCALES = new Set(['images', 'snippets', 'examples', 'node_modules']);

/** The value after `--name`, or the fallback. */
function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const PORT = Number(option('port', '4777'));
const DEFAULT_LOCALE = option('locale', 'es');
const OUT = resolve(option('out', join(tmpdir(), 'translation-viewer')));

/** Every `.mdx` page under a folder, as paths relative to it with `/` separators. */
function pagesUnder(root, base = '') {
  return readdirSync(join(root, base), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) return pagesUnder(root, path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

/** The locale folders: those with a `navigation.json` or a `Terms.md`. */
function locales() {
  return readdirSync(DOCS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_LOCALES.has(entry.name))
    .map((entry) => entry.name)
    .filter((name) => readdirSync(join(DOCS, name)).some((file) => file === 'navigation.json' || file === 'Terms.md'));
}

/** A docs file under `base`, or undefined when the path escapes it or is no page. */
function safePage(base, path) {
  if (!path.endsWith('.mdx')) return undefined;
  const full = resolve(base, path);
  return full.startsWith(base + sep) ? full : undefined;
}

/** Sends a JSON body. */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** The request body as text, capped at 5 MB. */
function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5_000_000) fail(new Error('body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(HERE, 'index.html')));
    } else if (url.pathname === '/api/locales') {
      json(res, 200, { locales: locales(), default: DEFAULT_LOCALE, out: OUT });
    } else if (url.pathname === '/api/tree') {
      const locale = url.searchParams.get('locale') ?? DEFAULT_LOCALE;
      if (!locales().includes(locale)) return json(res, 404, { error: 'unknown locale' });
      const english = new Set(pagesUnder(DOCS).filter((page) => !page.includes('/') || !locales().includes(page.split('/')[0])));
      const pages = pagesUnder(join(DOCS, locale)).filter((page) => english.has(page)).toSorted();
      json(res, 200, { pages });
    } else if (url.pathname === '/api/file') {
      const locale = url.searchParams.get('locale') ?? DEFAULT_LOCALE;
      const path = url.searchParams.get('path') ?? '';
      const translated = locales().includes(locale) ? safePage(join(DOCS, locale), path) : undefined;
      const source = safePage(DOCS, path);
      if (!translated || !source) return json(res, 400, { error: 'bad path' });
      json(res, 200, {
        english: readFileSync(source, 'utf8'),
        translated: readFileSync(translated, 'utf8'),
        glossary: readFileSync(join(DOCS, locale, existsSync(join(DOCS, locale, 'Terms.md')) ? 'Terms.md' : 'README.md'), 'utf8'),
      });
    } else if (url.pathname === '/api/findings' && req.method === 'POST') {
      const { locale, path, findings } = JSON.parse(await readBody(req));
      if (!locales().includes(locale) || !safePage(join(DOCS, locale), path)) return json(res, 400, { error: 'bad path' });
      const dir = join(OUT, locale);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${path.replaceAll('/', '__')}.json`), JSON.stringify({ path, findings }, null, 2));
      json(res, 200, { saved: true });
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (error) {
    json(res, 500, { error: String(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`translation-viewer: http://127.0.0.1:${PORT}/ (locale ${DEFAULT_LOCALE}, findings in ${OUT})`);
});
