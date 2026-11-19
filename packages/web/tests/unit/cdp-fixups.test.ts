/**
 * The CDP fixups in front of the chromium-bidi mapper: a redirect hop's
 * request-stage pause reaches the mapper after the hop's
 * `Network.requestWillBeSent`, whichever Chrome sent first, a load the
 * renderer starts over is continued with what its first pause was continued
 * with, a paused request's post data is answered from its pause until the
 * mapper answers the pause, a site icon's pauses, whose events the mapper
 * drops, are answered instead, a dedicated worker's pause reaches the mapper
 * again after the announcement that came behind it, and a request is one
 * whatever sessions report it, forgotten once its load ends on any of them
 * or all of them detached.
 */

import { describe, expect, it } from 'vitest';
import { cdpFixups, NO_POST_DATA, UNREPORTED_POST_DATA } from '../../src/driver/cdp-fixups.ts';

const willBeSent = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.requestWillBeSent', sessionId, params: { requestId } });
const redirected = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.requestWillBeSent', sessionId, params: { requestId, redirectResponse: { status: 302 } } });
/** The Fetch id Chrome gives the pause of hop `hop` of a load: one job per load, numbered by hop. */
const pauseId = (networkId: string, hop = 0, job = 'job'): string => `${job}-${networkId}.${String(hop)}`;
/** A request-stage pause of hop `hop` of request `networkId`; a redirect hop's names the pause of the hop before it, as Chrome's does. */
const paused = (networkId: string, hop = 0, sessionId = 's', extra: Record<string, unknown> = {}): string => JSON.stringify({
  method: 'Fetch.requestPaused',
  sessionId,
  params: { requestId: pauseId(networkId, hop), networkId, ...(hop === 0 ? {} : { redirectedRequestId: pauseId(networkId, hop - 1) }), ...extra },
});
/** The pause of a load of `networkId` the renderer started over: a new job, the same hop, no redirect named. */
const restarted = (networkId: string, sessionId = 's'): string => JSON.stringify({ method: 'Fetch.requestPaused', sessionId, params: { requestId: pauseId(networkId, 0, 'again'), networkId } });
const finished = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.loadingFinished', sessionId, params: { requestId } });
/** The mapper's continue of the pause `requestId`, with `overrides`. */
const continued = (requestId: string, overrides: Record<string, unknown> = {}, sessionId = 's'): { mapper: string } => ({
  mapper: JSON.stringify({ id: 7, method: 'Fetch.continueRequest', params: { requestId, ...overrides }, sessionId }),
});

/**
 * Runs `messages` through the fixups, the browser's as strings and the
 * mapper's commands as `{ mapper }`, and returns what the mapper received,
 * in order, and what was sent to the browser.
 */
function fix(messages: (string | { mapper: string })[]): { delivered: string[]; sent: unknown[] } {
  const delivered: string[] = [];
  const sent: unknown[] = [];
  const fixups = cdpFixups((message) => delivered.push(message), (message) => sent.push(JSON.parse(message)));
  for (const message of messages) {
    if (typeof message === 'string') fixups.receive(message);
    else fixups.send(message.mapper);
  }
  return { delivered, sent };
}

/** What the mapper received of `messages`, in order. */
const reorder = (messages: string[]): string[] => fix(messages).delivered;

/** Session `sessionId` of a target of `type` attached, through session `parent`. */
const attached = (sessionId: string, type: string, parent = 'page'): string => JSON.stringify({ method: 'Target.attachedToTarget', sessionId: parent, params: { sessionId, targetInfo: { type } } });
/** Session `sessionId` detached, as session `parent` tells. */
const detached = (sessionId: string, parent = 'page'): string => JSON.stringify({ method: 'Target.detachedFromTarget', sessionId: parent, params: { sessionId } });

const responseInfo = (requestId: string, statusCode: number, sessionId = 's'): string => JSON.stringify({ method: 'Network.responseReceivedExtraInfo', sessionId, params: { requestId, statusCode } });
const received = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.responseReceived', sessionId, params: { requestId, response: { status: 200 } } });

describe('cdpFixups response ExtraInfo', () => {
  it('passes the usual redirect order through', () => {
    const messages = [willBeSent('r'), responseInfo('r', 302), redirected('r'), responseInfo('r', 200), received('r'), finished('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('holds the next hop\'s response ExtraInfo that arrives before the redirect until the redirect is sent', () => {
    expect(reorder([willBeSent('r'), responseInfo('r', 302), responseInfo('r', 200), redirected('r'), received('r'), finished('r')]))
      .toEqual([willBeSent('r'), responseInfo('r', 302), redirected('r'), responseInfo('r', 200), received('r'), finished('r')]);
  });

  it('keeps a redirect\'s late ExtraInfo and the next hop\'s in the order Chrome sent them', () => {
    const messages = [willBeSent('r'), redirected('r'), responseInfo('r', 302), responseInfo('r', 200), received('r'), finished('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('keeps a hop answered twice without a redirect, as an auth retry is, in order before its response', () => {
    const messages = [willBeSent('r'), responseInfo('r', 401), responseInfo('r', 200), received('r'), finished('r')];
    expect(reorder(messages)).toEqual(messages);
  });
});

describe('cdpFixups', () => {
  it('passes the usual order through', () => {
    const messages = [willBeSent('r'), paused('r'), redirected('r'), paused('r', 1), finished('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('lets a first hop\'s early pause through, which the mapper handles', () => {
    const messages = [paused('r'), willBeSent('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('holds a redirect hop\'s early pause until the hop is sent', () => {
    const extra = JSON.stringify({ method: 'Network.requestWillBeSentExtraInfo', sessionId: 's', params: { requestId: 'r' } });
    expect(reorder([willBeSent('r'), paused('r'), paused('r', 1), extra, redirected('r')]))
      .toEqual([willBeSent('r'), paused('r'), extra, redirected('r'), paused('r', 1)]);
  });

  it('holds each early pause of a chain of redirects for its own hop', () => {
    expect(reorder([willBeSent('r'), paused('r'), paused('r', 1), redirected('r'), paused('r', 2), redirected('r'), finished('r')]))
      .toEqual([willBeSent('r'), paused('r'), redirected('r'), paused('r', 1), redirected('r'), paused('r', 2), finished('r')]);
  });

  it('never holds a response-stage pause', () => {
    const response = paused('r', 1, 's', { responseStatusCode: 302 });
    expect(reorder([willBeSent('r'), paused('r'), response])).toEqual([willBeSent('r'), paused('r'), response]);
  });

  it('never holds a redirect pause of a request no session announced', () => {
    const messages = [paused('r'), paused('r', 1)];
    expect(reorder(messages)).toEqual(messages);
  });

  it('hands a held pause on when its request ends without another hop', () => {
    expect(reorder([willBeSent('r'), paused('r'), paused('r', 1), finished('r')]))
      .toEqual([willBeSent('r'), paused('r'), finished('r'), paused('r', 1)]);
  });

  it('continues a site icon\'s request-stage pause itself and never hands it to the mapper', () => {
    const icon = (networkId: string, url: string): string => JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 's', params: { requestId: `fetch-${networkId}`, networkId, request: { url } } });
    const page = icon('p', 'http://app.test/favicon.ico?v=1');
    const { delivered, sent } = fix([willBeSent('i'), icon('i', 'http://app.test/assets/favicon.ico'), willBeSent('p'), page]);
    expect(delivered).toEqual([willBeSent('i'), willBeSent('p'), page]);
    expect(sent).toEqual([{ id: 2_000_000_000, method: 'Fetch.continueRequest', params: { requestId: 'fetch-i' }, sessionId: 's' }]);
  });

  it('continues a site icon\'s early redirect-hop pause once its hop is sent', () => {
    const icon = paused('r', 1, 's', { request: { url: 'http://app.test/favicon.ico' } });
    const { delivered, sent } = fix([willBeSent('r'), paused('r'), icon]);
    expect(delivered).toEqual([willBeSent('r'), paused('r')]);
    expect(sent).toEqual([]);
    const after = fix([willBeSent('r'), paused('r'), icon, redirected('r')]);
    expect(after.sent).toEqual([{ id: 2_000_000_000, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 1) }, sessionId: 's' }]);
  });

  it('answers a site icon\'s auth challenge with the browser\'s default', () => {
    const challenge = JSON.stringify({ method: 'Fetch.authRequired', sessionId: 's', params: { requestId: 'fetch-i', request: { url: 'http://app.test/favicon.ico' } } });
    const other = JSON.stringify({ method: 'Fetch.authRequired', sessionId: 's', params: { requestId: 'fetch-o', request: { url: 'http://app.test/private' } } });
    const { delivered, sent } = fix([challenge, other]);
    expect(delivered).toEqual([other]);
    expect(sent).toEqual([{ id: 2_000_000_000, method: 'Fetch.continueWithAuth', params: { requestId: 'fetch-i', authChallengeResponse: { response: 'Default' } }, sessionId: 's' }]);
  });
});

describe('cdpFixups restarted loads', () => {
  /** What Chrome sent for a web font under an intercept: one request announced once and paused twice, each pause a job of its own. */
  const font = (job: number): string => JSON.stringify({
    method: 'Fetch.requestPaused',
    sessionId: 's',
    params: { requestId: `interception-job-${String(job)}.0`, networkId: '75650.2', resourceType: 'Font', request: { url: 'http://app.test/font.woff2', method: 'GET' } },
  });
  const headers = [{ name: 'x-gate', value: 'open' }];

  it('hands the second pause of a font to the mapper at once', () => {
    const messages = [willBeSent('75650.2'), font(2), font(3)];
    expect(reorder(messages)).toEqual(messages);
  });

  it('sends the mapper\'s continue of the second pause with what the first was continued with', () => {
    const { delivered, sent } = fix([
      willBeSent('75650.2'),
      font(2),
      continued('interception-job-2.0', { headers, url: 'http://cdn.test/font.woff2' }),
      font(3),
      continued('interception-job-3.0'),
    ]);
    expect(delivered).toEqual([willBeSent('75650.2'), font(2), font(3)]);
    expect(sent).toEqual([
      { id: 7, method: 'Fetch.continueRequest', params: { requestId: 'interception-job-2.0', headers, url: 'http://cdn.test/font.woff2' }, sessionId: 's' },
      { id: 7, method: 'Fetch.continueRequest', params: { requestId: 'interception-job-3.0', headers, url: 'http://cdn.test/font.woff2' }, sessionId: 's' },
    ]);
  });

  it('sends a continue of a restart as it is when the first pause was continued untouched', () => {
    const { sent } = fix([willBeSent('r'), paused('r'), continued(pauseId('r')), restarted('r'), continued(pauseId('r', 0, 'again'))]);
    expect(sent).toEqual([
      { id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r') }, sessionId: 's' },
      { id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 0, 'again') }, sessionId: 's' },
    ]);
  });

  it('gives a redirect hop its own continue, not the one of the hop before it', () => {
    const { sent } = fix([
      willBeSent('r'),
      paused('r'),
      continued(pauseId('r'), { headers }),
      redirected('r'),
      paused('r', 1),
      continued(pauseId('r', 1), { method: 'GET' }),
    ]);
    expect(sent.at(-1)).toEqual({ id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 1), method: 'GET' }, sessionId: 's' });
  });

  it('takes a continue as the answer of a pause only on the session that paused', () => {
    const { sent } = fix([
      willBeSent('r', 'a'),
      paused('r', 0, 'a'),
      continued(pauseId('r'), { headers }, 'b'),
      restarted('r', 'a'),
      continued(pauseId('r', 0, 'again'), {}, 'a'),
    ]);
    expect(sent.at(-1)).toEqual({ id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 0, 'again') }, sessionId: 'a' });
  });

  it('forgets a request once its load ends', () => {
    const { sent } = fix([willBeSent('r'), paused('r'), continued(pauseId('r'), { headers }), restarted('r'), finished('r'), continued(pauseId('r', 0, 'again'))]);
    expect(sent.at(-1)).toEqual({ id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 0, 'again') }, sessionId: 's' });
  });

  it('sends every other command of the mapper as it wrote it', () => {
    const evaluate = { id: 9, method: 'Runtime.evaluate', params: { expression: '"Fetch.continueRequest"' }, sessionId: 's' };
    const { sent } = fix([willBeSent('r'), paused('r'), { mapper: JSON.stringify(evaluate) }, { mapper: JSON.stringify({ id: 10, method: 'Fetch.failRequest', params: { requestId: pauseId('r'), errorReason: 'Failed' }, sessionId: 's' }) }]);
    expect(sent).toEqual([evaluate, { id: 10, method: 'Fetch.failRequest', params: { requestId: pauseId('r'), errorReason: 'Failed' }, sessionId: 's' }]);
  });
});

describe('cdpFixups request bodies', () => {
  const base64 = (bytes: number[] | string): string => Buffer.from(bytes as never).toString('base64');
  /** A request-stage pause of `networkId` whose request Chrome lists `entries` for, each its bytes or none; `undefined` for a request without a body. */
  const posting = (networkId: string, entries: readonly (string | null)[] | undefined, hop = 0, sessionId = 's'): string => paused(networkId, hop, sessionId, {
    request: {
      url: 'http://app.test/upload',
      method: 'POST',
      ...(entries === undefined ? {} : { hasPostData: true, postDataEntries: entries.map((bytes) => (bytes === null ? {} : { bytes })) }),
    },
  });
  /** The mapper's `Network.getRequestPostData` for `requestId`. */
  const asked = (requestId: string, sessionId = 's'): { mapper: string } => ({ mapper: JSON.stringify({ id: 11, method: 'Network.getRequestPostData', params: { requestId }, sessionId }) });
  /** What the mapper received in answer to its command 11, parsed. */
  const answer = (delivered: string[]): unknown => delivered.map((message) => JSON.parse(message) as { id?: number }).find((message) => message.id === 11);

  it('answers the post data of a paused request with the bytes of every entry of its pause, and sends the browser nothing', () => {
    const { delivered, sent } = fix([willBeSent('r'), posting('r', [base64('--b\r\n'), base64([0xff, 0x00, 0x41]), base64('\r\n--b--')]), asked('r')]);
    expect(answer(delivered)).toEqual({ id: 11, result: { postData: Buffer.concat([Buffer.from('--b\r\n'), Buffer.from([0xff, 0x00, 0x41]), Buffer.from('\r\n--b--')]).toString('base64'), base64Encoded: true }, sessionId: 's' });
    expect(sent).toEqual([]);
  });

  it('answers a request paused without a body as Chrome does', () => {
    const { delivered, sent } = fix([willBeSent('r'), posting('r', undefined), asked('r')]);
    expect(answer(delivered)).toEqual({ id: 11, error: { code: -32000, message: NO_POST_DATA }, sessionId: 's' });
    expect(sent).toEqual([]);
  });

  it('answers a body with an entry that has no bytes, a file on disk or a stream, with the failure that names it', () => {
    for (const entries of [[base64('--b'), null, base64('--b--')], [null]]) {
      const { delivered, sent } = fix([willBeSent('r'), posting('r', entries), asked('r')]);
      expect(answer(delivered)).toEqual({ id: 11, error: { code: -32000, message: UNREPORTED_POST_DATA }, sessionId: 's' });
      expect(sent).toEqual([]);
    }
  });

  it('answers a body of no entries as empty, and one Chrome names without listing its entries with the failure', () => {
    const { delivered } = fix([willBeSent('r'), posting('r', []), asked('r')]);
    expect(answer(delivered)).toEqual({ id: 11, result: { postData: '', base64Encoded: true }, sessionId: 's' });
    const unlisted = paused('r', 0, 's', { request: { url: 'http://app.test/upload', method: 'POST', hasPostData: true } });
    expect(answer(fix([willBeSent('r'), unlisted, asked('r')]).delivered)).toEqual({ id: 11, error: { code: -32000, message: UNREPORTED_POST_DATA }, sessionId: 's' });
  });

  it('answers with the body of the hop in flight once a redirect dropped or kept it', () => {
    const dropped = fix([willBeSent('r'), posting('r', [base64('a=1')]), redirected('r'), posting('r', undefined, 1), asked('r')]);
    expect(answer(dropped.delivered)).toEqual({ id: 11, error: { code: -32000, message: NO_POST_DATA }, sessionId: 's' });
    const kept = fix([willBeSent('r'), posting('r', [base64('a=1')]), redirected('r'), posting('r', [base64('a=1')], 1), asked('r')]);
    expect(answer(kept.delivered)).toMatchObject({ result: { postData: base64('a=1') } });
  });

  it('sends the browser the command for a request that is not paused: one never held, another session\'s, one whose load ended', () => {
    const command = { id: 11, method: 'Network.getRequestPostData', params: { requestId: 'r' }, sessionId: 's' };
    expect(fix([willBeSent('r'), asked('r')]).sent).toEqual([command]);
    expect(fix([willBeSent('r', 'other'), posting('r', [base64('a=1')], 0, 'other'), asked('r')]).sent).toEqual([command]);
    expect(fix([willBeSent('r'), posting('r', [base64('a=1')]), finished('r'), asked('r')]).sent).toEqual([command]);
  });

  it('keeps the body no longer than the pause: once the mapper continued, fulfilled, or failed it, the browser is asked', () => {
    const command = { id: 11, method: 'Network.getRequestPostData', params: { requestId: 'r' }, sessionId: 's' };
    for (const method of ['Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest']) {
      const answered = { id: 7, method, params: { requestId: pauseId('r') }, sessionId: 's' };
      const { delivered, sent } = fix([willBeSent('r'), posting('r', [base64('a=1')]), { mapper: JSON.stringify(answered) }, asked('r')]);
      expect(answer(delivered)).toBeUndefined();
      expect(sent).toEqual([answered, command]);
    }
  });

  it('answers from the pause of a load that started over after its first pause was answered', () => {
    const again = JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 's', params: { requestId: pauseId('r', 0, 'again'), networkId: 'r', request: { url: 'http://app.test/upload', method: 'POST', hasPostData: true, postDataEntries: [{ bytes: base64('b=2') }] } } });
    const { delivered } = fix([willBeSent('r'), posting('r', [base64('a=1')]), continued(pauseId('r')), again, asked('r')]);
    expect(answer(delivered)).toMatchObject({ result: { postData: base64('b=2') } });
  });

  it('forgets a request paused on one session once its load ends on another, as a worker\'s fetch does: the browser is asked for its body', () => {
    const command = { id: 11, method: 'Network.getRequestPostData', params: { requestId: 'r' }, sessionId: 'page' };
    const fetched = [willBeSent('r', 'worker'), posting('r', [base64('a=1')], 0, 'page')];
    expect(answer(fix([...fetched, asked('r', 'page')]).delivered)).toMatchObject({ result: { postData: base64('a=1') } });
    const { delivered, sent } = fix([...fetched, finished('r', 'worker'), asked('r', 'page')]);
    expect(answer(delivered)).toBeUndefined();
    expect(sent).toEqual([command]);
  });
});

describe('cdpFixups worker requests', () => {
  const worker = attached('worker', 'worker');

  it('hands the mapper a worker\'s pause again after the worker\'s session announces the request behind it', () => {
    expect(reorder([worker, paused('r', 0, 'page'), willBeSent('r', 'worker')]))
      .toEqual([worker, paused('r', 0, 'page'), willBeSent('r', 'worker'), paused('r', 0, 'page')]);
  });

  it('hands the pause again once, however many hops the worker\'s session announces', () => {
    expect(reorder([worker, paused('r', 0, 'page'), willBeSent('r', 'worker'), redirected('r', 'worker'), paused('r', 1, 'page')]))
      .toEqual([worker, paused('r', 0, 'page'), willBeSent('r', 'worker'), paused('r', 0, 'page'), redirected('r', 'worker'), paused('r', 1, 'page')]);
  });

  it('leaves a worker\'s request alone when its announcement comes first', () => {
    const messages = [worker, willBeSent('r', 'worker'), paused('r', 0, 'page'), finished('r', 'worker')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('never hands a pause again that the mapper answered before the announcement', () => {
    for (const method of ['Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest']) {
      const answered = { mapper: JSON.stringify({ id: 7, method, params: { requestId: pauseId('r') }, sessionId: 'page' }) };
      expect(fix([worker, paused('r', 0, 'page'), answered, willBeSent('r', 'worker')]).delivered)
        .toEqual([worker, paused('r', 0, 'page'), willBeSent('r', 'worker')]);
    }
  });

  it('never hands a pause again for an announcement on a session that is no dedicated worker\'s: the page\'s own, a frame\'s, a shared worker\'s, a worker\'s that detached', () => {
    const own = [worker, paused('r', 0, 'page'), willBeSent('r', 'page')];
    expect(reorder(own)).toEqual(own);
    for (const type of ['iframe', 'shared_worker', 'service_worker']) {
      const other = [attached('other', type), paused('r', 0, 'page'), willBeSent('r', 'other')];
      expect(reorder(other)).toEqual(other);
    }
    const gone = [worker, detached('worker'), paused('r', 0, 'page'), willBeSent('r', 'worker')];
    expect(reorder(gone)).toEqual(gone);
  });

  it('holds a worker\'s redirect pause on the page\'s session until the worker\'s session announces the hop', () => {
    expect(reorder([willBeSent('r', 'worker'), paused('r', 0, 'page'), paused('r', 1, 'page'), redirected('r', 'worker'), finished('r', 'worker')]))
      .toEqual([willBeSent('r', 'worker'), paused('r', 0, 'page'), redirected('r', 'worker'), paused('r', 1, 'page'), finished('r', 'worker')]);
  });

  it('holds the next hop\'s response ExtraInfo from the page\'s session until the worker\'s session announces the redirect', () => {
    expect(reorder([willBeSent('r', 'worker'), responseInfo('r', 307, 'page'), responseInfo('r', 200, 'page'), redirected('r', 'worker'), received('r', 'worker'), finished('r', 'worker')]))
      .toEqual([willBeSent('r', 'worker'), responseInfo('r', 307, 'page'), redirected('r', 'worker'), responseInfo('r', 200, 'page'), received('r', 'worker'), finished('r', 'worker')]);
  });

  it('hands a response ExtraInfo held on the page\'s session on before the response the worker\'s session reports', () => {
    const messages = [willBeSent('r', 'worker'), responseInfo('r', 401, 'page'), responseInfo('r', 200, 'page'), received('r', 'worker'), finished('r', 'worker')];
    expect(reorder(messages)).toEqual(messages);
  });
});

describe('cdpFixups detached sessions', () => {
  const base64 = (text: string): string => Buffer.from(text).toString('base64');
  /** A request-stage pause of `networkId` on `sessionId` that posts `text`. */
  const posting = (networkId: string, text: string, sessionId: string): string => paused(networkId, 0, sessionId, { request: { url: 'http://app.test/upload', method: 'POST', hasPostData: true, postDataEntries: [{ bytes: base64(text) }] } });
  const asked = (requestId: string, sessionId: string): { mapper: string } => ({ mapper: JSON.stringify({ id: 11, method: 'Network.getRequestPostData', params: { requestId }, sessionId }) });

  it('hands the pauses held for a hop on when the session that was to announce it detaches', () => {
    expect(reorder([willBeSent('r', 'worker'), paused('r', 0, 'page'), paused('r', 1, 'page'), detached('worker')]))
      .toEqual([willBeSent('r', 'worker'), paused('r', 0, 'page'), detached('worker'), paused('r', 1, 'page')]);
  });

  it('holds no later redirect pause of a request whose announcing session detached', () => {
    const messages = [willBeSent('r', 'worker'), paused('r', 0, 'page'), detached('worker'), paused('r', 1, 'page')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('drops the pauses a detached session held, which nothing can answer any more', () => {
    const own = [willBeSent('r', 'page'), paused('r', 0, 'page'), paused('r', 1, 'page'), detached('page', 'tab'), finished('r', 'frame')];
    expect(reorder(own)).toEqual([willBeSent('r', 'page'), paused('r', 0, 'page'), detached('page', 'tab'), finished('r', 'frame')]);
    const announcedElsewhere = [willBeSent('r', 'worker'), paused('r', 0, 'page'), paused('r', 1, 'page'), detached('page', 'tab'), redirected('r', 'worker'), finished('r', 'worker')];
    expect(reorder(announcedElsewhere)).toEqual([willBeSent('r', 'worker'), paused('r', 0, 'page'), detached('page', 'tab'), redirected('r', 'worker'), finished('r', 'worker')]);
  });

  it('keeps a request while a session that reported it is attached, and forgets it once they all detached', () => {
    const command = { id: 11, method: 'Network.getRequestPostData', params: { requestId: 'r' }, sessionId: 'page' };
    const posted = [willBeSent('r', 'worker'), posting('r', 'a=1', 'page')];
    const kept = fix([...posted, detached('worker'), asked('r', 'page')]);
    expect(kept.delivered.map((message) => JSON.parse(message) as { id?: number }).find((message) => message.id === 11)).toMatchObject({ result: { postData: base64('a=1') } });
    expect(kept.sent).toEqual([]);
    expect(fix([...posted, detached('worker'), detached('page', 'tab'), asked('r', 'page')]).sent).toEqual([command]);
  });

  it('asks the browser for the body of a request whose pausing session detached', () => {
    const command = { id: 11, method: 'Network.getRequestPostData', params: { requestId: 'r' }, sessionId: 'page' };
    expect(fix([willBeSent('r', 'worker'), posting('r', 'a=1', 'page'), detached('page', 'tab'), asked('r', 'page')]).sent).toEqual([command]);
  });
});

describe('cdpFixups across sessions', () => {
  const headers = [{ name: 'x-gate', value: 'open' }];

  it('forgets what a pause was continued with once the load ends on another session, as a document that commits in another process does', () => {
    const { sent } = fix([
      willBeSent('r', 'parent'),
      paused('r', 0, 'parent'),
      continued(pauseId('r'), { headers }, 'parent'),
      finished('r', 'frame'),
      restarted('r', 'parent'),
      continued(pauseId('r', 0, 'again'), {}, 'parent'),
    ]);
    expect(sent.at(-1)).toEqual({ id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 0, 'again') }, sessionId: 'parent' });
  });

  it('hands a pause held on one session on when its request ends on another', () => {
    expect(reorder([willBeSent('r', 'parent'), paused('r', 0, 'parent'), paused('r', 1, 'parent'), finished('r', 'frame')]))
      .toEqual([willBeSent('r', 'parent'), paused('r', 0, 'parent'), finished('r', 'frame'), paused('r', 1, 'parent')]);
  });

  it('hands a response ExtraInfo held on one session on before the end that arrives on another', () => {
    expect(reorder([willBeSent('r', 'parent'), responseInfo('r', 401, 'parent'), responseInfo('r', 200, 'parent'), finished('r', 'frame')]))
      .toEqual([willBeSent('r', 'parent'), responseInfo('r', 401, 'parent'), responseInfo('r', 200, 'parent'), finished('r', 'frame')]);
  });

  it('leaves another request of the session alone when one ends elsewhere', () => {
    const { sent } = fix([
      willBeSent('kept', 'page'),
      paused('kept', 0, 'page'),
      continued(pauseId('kept'), { headers }, 'page'),
      willBeSent('r', 'worker'),
      paused('r', 0, 'page'),
      finished('r', 'worker'),
      restarted('kept', 'page'),
      continued(pauseId('kept', 0, 'again'), {}, 'page'),
    ]);
    expect(sent.at(-1)).toEqual({ id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('kept', 0, 'again'), headers }, sessionId: 'page' });
  });
});
