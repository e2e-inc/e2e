/**
 * A route on a form submission that navigates, on both browsers: the route
 * reads the form as `postData`, `route.fetch()` sends it upstream, and a
 * route that lets the submission go on still sends its fields.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WebRoute } from '../../src/fixture/types.ts';
import { byRole, startWebSession, type WebSession } from '../helpers/web-session.ts';

/** The form's fields as a browser encodes them. */
const FORM_BODY = 'name=Ada&note=two+words';

describe('a route on a form submission that navigates', () => {
  let session: WebSession;
  let form: string;
  let submit: string;
  /** The body of every submission that reached the server. */
  const submitted: string[] = [];

  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 10_000, startAttempt: false });
    form = session.serve('/form', `<!doctype html><title>Form</title>
      <form method="post" action="/submit"><input name="name" value="Ada"><input name="note" value="two words"><button>Send</button></form>`);
    submit = session.serve('/submit', (request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        submitted.push(body);
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(body);
      });
    });
  });

  beforeEach(async () => {
    submitted.length = 0;
    await session.startAttempt();
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  /** Submits the form with `handle` routing the submission, and resolves with the page it lands on: the fields the server answered it received. */
  async function submitThrough(handle: (route: WebRoute) => Promise<void>): Promise<string | null> {
    await session.open(form);
    await session.browser.route('**/submit', handle);
    await session.act(byRole('button', 'Send'), { kind: 'tap' });
    await session.browser.waitForURL(submit);
    return session.browser.evaluate(() => document.body.textContent);
  }

  it('hands the route the form as postData, and the submission it lets go on still carries the form', async () => {
    const seen: { method: string; postData: string | undefined }[] = [];

    const received = await submitThrough(async (route) => {
      seen.push({ method: route.request.method, postData: route.request.postData });
      await route.continue();
    });

    expect(seen).toEqual([{ method: 'POST', postData: FORM_BODY }]);
    expect(received).toBe(FORM_BODY);
    expect(submitted).toEqual([FORM_BODY]);
  });

  it('sends the form upstream from route.fetch()', async () => {
    const received = await submitThrough(async (route) => {
      const upstream = await route.fetch();
      await route.fulfill({ status: upstream.status, contentType: upstream.headers['content-type']!, body: await upstream.text() });
    });

    expect(received).toBe(FORM_BODY);
    expect(submitted).toEqual([FORM_BODY]);
  });
});
