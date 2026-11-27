import type { RawWindow } from './driver.ts';

/** What `desktop.useWindow()` picks a window by: the id `desktop.windows()` gave, or its title. */
export type WindowChoice = { readonly id: string } | { readonly title: string | RegExp };

/** The windows a title names: the whole title for a string, a match anywhere for a pattern. */
export function titled(windows: readonly RawWindow[], title: string | RegExp): readonly RawWindow[] {
  // `search` starts at the title's first character whatever a `g` pattern's last match left behind.
  return windows.filter((window) => (typeof title === 'string' ? (window.title ?? '') === title : (window.title ?? '').search(title) !== -1));
}

/** A title as an error message and a step label show it. */
export function titleText(title: string | RegExp): string {
  return typeof title === 'string' ? JSON.stringify(title) : String(title);
}

/** Why a title picked no window in time: the titles the app's windows have instead. */
export function noWindowTitled(app: string, title: string | RegExp, windows: readonly RawWindow[], waitedMs: number): string {
  const has = windows.length === 0 ? 'it has no open window' : `its windows are ${windows.map((window) => JSON.stringify(window.title ?? '')).join(', ')}`;
  return `${app} showed no window titled ${titleText(title)} within ${waitedMs} ms; ${has}`;
}

/** Why a title two windows have picks neither. */
export function ambiguousTitle(app: string, title: string | RegExp, matches: readonly RawWindow[]): string {
  const named = matches.map((window) => `${JSON.stringify(window.title ?? '')} (id ${window.id})`).join(', ');
  return `${matches.length} windows of ${app} are titled ${titleText(title)}: ${named}; pass the one meant from desktop.windows()`;
}
