/**
 * Local server for the translation review viewer: a file tree of one
 * locale's pages, each beside its English source, with a review run in the
 * browser by Chrome's built-in model. No dependencies.
 *
 * Usage: node server.ts [--locale es] [--port 4777] [--out <dir>]
 *
 * Findings the page posts are written to `<out>/<locale>/<page>.json` (a
 * `/` in the page path becomes `__`), so the agent that started the server
 * can read and apply them.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS, locales, modelText, pagesUnder, parseTerms, read, sections, termsIn, termsPath } from '../../translation-review/scripts/lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The value after `--name`, or the fallback. */
function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const PORT = Number(option('port', '4777'));
const REQUESTED_LOCALE = option('locale', 'es');
const OUT = resolve(option('out', join(tmpdir(), 'translation-viewer')));
const ORIGIN = `127.0.0.1:${PORT}`;

const DETECTED = locales();
if (DETECTED.length === 0) {
  console.error('No locale folder under docs/ has a navigation.json or a Terms.md.');
  process.exit(1);
}
if (!DETECTED.includes(REQUESTED_LOCALE)) console.warn(`--locale ${REQUESTED_LOCALE} is not a locale folder (${DETECTED.join(', ')}); using ${DETECTED[0]}`);
const DEFAULT_LOCALE = DETECTED.includes(REQUESTED_LOCALE) ? REQUESTED_LOCALE : (DETECTED[0] ?? 'es');

/** A docs file under `base`, or undefined when the path escapes it or is no page. */
function safePage(base: string, path: string): string | undefined {
  if (!path.endsWith('.mdx')) return undefined;
  const full = resolve(base, path);
  return full.startsWith(base + sep) ? full : undefined;
}

/** Sends a JSON body. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** The request body as text, capped at 5 MB. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
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
  // Only this page may talk to the server: a rebinding or cross-site request names another host or origin.
  if (req.headers.host !== ORIGIN || (req.headers.origin !== undefined && req.headers.origin !== `http://${ORIGIN}`)) return json(res, 403, { error: 'forbidden' });
  try {
    const known = locales();
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(HERE, 'index.html')));
    } else if (url.pathname === '/api/locales') {
      json(res, 200, { locales: known, default: DEFAULT_LOCALE, out: OUT });
    } else if (url.pathname === '/api/tree') {
      const locale = url.searchParams.get('locale') ?? DEFAULT_LOCALE;
      if (!known.includes(locale)) return json(res, 404, { error: 'unknown locale' });
      const english = new Set(pagesUnder(DOCS).filter((page) => !known.includes(page.split('/')[0] ?? '')));
      const pages = pagesUnder(join(DOCS, locale)).filter((page) => english.has(page)).toSorted();
      json(res, 200, { pages });
    } else if (url.pathname === '/api/file') {
      const locale = url.searchParams.get('locale') ?? DEFAULT_LOCALE;
      const path = url.searchParams.get('path') ?? '';
      const translated = known.includes(locale) ? safePage(join(DOCS, locale), path) : undefined;
      const source = safePage(DOCS, path);
      if (!translated || !source) return json(res, 400, { error: 'bad path' });
      if (!existsSync(translated) || !existsSync(source)) return json(res, 404, { error: 'page not found' });
      const terms = existsSync(termsPath(locale)) ? parseTerms(read(termsPath(locale))) : [];
      const en = sections(read(source));
      const tr = sections(read(translated));
      const rows = Array.from({ length: Math.max(en.length, tr.length) }, (_, i) => {
        const english = modelText(en[i]?.lines ?? []);
        return {
          heading: tr[i]?.heading ?? en[i]?.heading ?? '',
          english: (en[i]?.lines ?? []).join('\n'),
          translated: (tr[i]?.lines ?? []).join('\n'),
          englishText: english,
          translatedText: modelText(tr[i]?.lines ?? []),
          terms: termsIn(english, terms),
        };
      });
      json(res, 200, {
        outlinesMatch: en.length === tr.length,
        englishSections: en.length,
        translatedSections: tr.length,
        sections: rows,
        guideFiles: ['README.md', 'Terms.md'].filter((name) => existsSync(join(DOCS, locale, name))).map((name) => `docs/${locale}/${name}`),
      });
    } else if (url.pathname === '/api/findings' && req.method === 'POST') {
      if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'application/json only' });
      const { locale, path, findings } = JSON.parse(await readBody(req)) as { locale: string; path: string; findings: unknown };
      if (!known.includes(locale) || typeof path !== 'string' || !safePage(join(DOCS, locale), path)) return json(res, 400, { error: 'bad path' });
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
