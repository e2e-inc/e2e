/**
 * The tabs of a remote Chrome, opened, shown, and closed over its DevTools
 * HTTP endpoint with no driver attached, so no preload of an attach ever ran
 * in the documents they show.
 */

import { expect } from 'vitest';
import type { PageServer } from './web-session.ts';
import { gate } from './gate.ts';

/** One tab Chrome lists: its target id and the URL it shows. */
export interface OpenTab {
  readonly id: string;
  readonly url: string;
}

/** The tabs Chrome lists over its DevTools HTTP endpoint. */
export async function openTabs(endpoint: string): Promise<OpenTab[]> {
  const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as { id: string; type: string; url: string }[];
  return targets.filter((target) => target.type === 'page').map(({ id, url }) => ({ id, url }));
}

/**
 * Opens a tab on `html`, served at `pathname`, in front of the tabs already
 * open, and resolves once its document has run its scripts.
 */
export async function openTab(endpoint: string, server: PageServer, pathname: string, html: string): Promise<OpenTab> {
  const { held: ready, release: loaded } = gate();
  server.serve(`${pathname}-loaded`, (_request, response) => {
    loaded();
    response.end();
  });
  const url = server.serve(pathname, `${html}<script>fetch(${JSON.stringify(`${pathname}-loaded`)})</script>`);
  const { id } = (await (await fetch(`${endpoint}/json/new?${url}`, { method: 'PUT' })).json()) as { id: string };
  await ready;
  return { id, url };
}

/** Has Chrome show `html`, served at `pathname`, in its only tab: opens it (`openTab`) and closes every tab that was open. */
export async function showOnly(endpoint: string, server: PageServer, pathname: string, html: string): Promise<OpenTab> {
  const before = await openTabs(endpoint);
  const tab = await openTab(endpoint, server, pathname, html);
  for (const old of before) await fetch(`${endpoint}/json/close/${old.id}`);
  await expect.poll(() => openTabs(endpoint)).toEqual([tab]);
  return tab;
}

/** Brings `tab` to the front of its window. */
export async function showTab(endpoint: string, tab: OpenTab): Promise<void> {
  await fetch(`${endpoint}/json/activate/${tab.id}`);
}
