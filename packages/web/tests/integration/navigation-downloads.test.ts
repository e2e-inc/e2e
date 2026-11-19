/**
 * A `goto` whose response turns into a download fails as Playwright's does,
 * with "Download is starting", while the download itself is saved; an abort
 * no download follows keeps its own error. That such an abort waits for no
 * download is pinned over a scripted peer (`unit/steering.test.ts`).
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('navigations that turn into downloads', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000 });
  });
  afterAll(async () => {
    await page.close();
  });

  it('fails the navigation as a starting download and saves the file', async () => {
    const start = page.serve('/start', '<p>start</p>');
    const attachment = page.serve('/attachment', (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=hello.txt' });
      response.end('Hello world');
    });
    await page.browser.goto(start);
    let failure: unknown;
    const download = await page.browser.waitForDownload(async () => {
      failure = await page.browser.goto(attachment).catch((caught: unknown) => caught);
    });
    expect((failure as Error).message).toContain('Download is starting');
    expect(download.suggestedFilename).toBe('hello.txt');
    expect(await page.browser.url()).toBe(start);
  });

  it('saves the file of a wait whose timeout is a fraction of a millisecond', async () => {
    const attachment = page.serve('/fraction', (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=fraction.txt' });
      response.end('Hello fraction');
    });
    await page.browser.goto(page.serve('/before-fraction', '<p>start</p>'));
    const download = await page.browser.waitForDownload(async () => {
      await page.browser.goto(attachment).catch(() => undefined);
    }, { timeout: 2500.5 });
    expect(download.suggestedFilename).toBe('fraction.txt');
    expect(readFileSync(download.absolutePath, 'utf8')).toBe('Hello fraction');
  });

  it('keeps the abort of a navigation to a No Content response', async () => {
    const empty = page.serve('/no-content', (_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const failure = await page.browser.goto(empty).catch((caught: unknown) => caught);
    expect((failure as Error).message).toContain(onFirefox ? 'NS_BINDING_ABORTED' : 'net::ERR_ABORTED');
  });
});
