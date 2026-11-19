/**
 * A tab of a remote Chrome read and changed the way its host does: over a
 * DevTools session of the test's own on the tab's target, apart from any
 * driver attached to the browser, so what it reads is what the page shows
 * whoever else drives it, and after they left.
 */

import type { OpenTab } from './cdp-tabs.ts';

/** How long the tab may take to answer one evaluation. */
const ANSWER_TIMEOUT_MS = 15_000;

/**
 * Evaluates `expression` in the document `tab` shows, as its user acting on
 * the page (so it may open a tab), and resolves with its JSON value, a
 * promise's once it settles. Rejects with what the expression threw.
 */
export async function evaluateInTab<T>(endpoint: string, tab: Pick<OpenTab, 'id'>, expression: string): Promise<T> {
  const socket = new WebSocket(`ws://${new URL(endpoint).host}/devtools/page/${tab.id}`);
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`tab ${tab.id} did not answer ${expression} within ${String(ANSWER_TIMEOUT_MS)}ms`)), ANSWER_TIMEOUT_MS);
      const settle = (work: () => void): void => {
        clearTimeout(timer);
        work();
      };
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } })));
      socket.addEventListener('error', () => settle(() => reject(new Error(`no DevTools session opened on tab ${tab.id}`))));
      socket.addEventListener('close', () => settle(() => reject(new Error(`the DevTools session on tab ${tab.id} closed before it answered ${expression}`))));
      socket.addEventListener('message', (event) => {
        const reply = JSON.parse(String(event.data)) as {
          id?: number;
          error?: { message: string };
          result?: { result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
        };
        if (reply.id !== 1) return;
        const thrown = reply.result?.exceptionDetails;
        if (reply.error !== undefined) settle(() => reject(new Error(reply.error!.message)));
        else if (thrown !== undefined) settle(() => reject(new Error(thrown.exception?.description ?? thrown.text)));
        else settle(() => resolve(reply.result!.result.value as T));
      });
    });
  } finally {
    socket.close();
  }
}
