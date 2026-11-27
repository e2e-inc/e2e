/**
 * The `desktop` fixture's recording policy: how a test line from `e2e mcp`
 * writes `desktop.useWindow`, whose window id holds only while the window
 * stays open.
 */

import { describe, expect, it } from 'vitest';
import type { EngineFixtureContext, FixtureOperations } from '@e2e-dev/core/engine';
import { createDesktopFixture, type Desktop } from '../../src/desktop.ts';
import type { DesktopSurface } from '../../src/surface.ts';

/** The operations the fixture declares, read off a context that only records them. */
function declared(): FixtureOperations<Desktop> {
  let operations: FixtureOperations<Desktop> | undefined;
  const context = {
    fixture: (_name: string, surface: Desktop, declaredOperations: FixtureOperations<Desktop>) => {
      operations = declaredOperations;
      return surface;
    },
  } as unknown as EngineFixtureContext;
  createDesktopFixture({ platform: 'macos' } as unknown as DesktopSurface, context);
  return operations!;
}

describe('desktop fixture', () => {
  it('writes the window useWindow got by its title, which holds on the next launch, and says when it cannot', () => {
    const testLine = declared().useWindow?.testLine;
    expect(testLine?.({ id: '36086', title: 'Inbox "all"', focused: true })).toEqual({
      args: '(await desktop.windows()).find((window) => window.title === "Inbox \\"all\\"") ?? "titled Inbox \\"all\\""',
    });
    expect(testLine?.({ id: '36090', title: '', focused: false })).toEqual({ note: expect.stringMatching(/^a window id holds only while the window stays open/) });
    // Plain JavaScript in run_code can pass a window with no title at all.
    expect(testLine?.({ id: '36091' } as unknown as Parameters<NonNullable<typeof testLine>>[0])).toEqual({ note: expect.stringMatching(/^a window id/) });
    expect(testLine?.('36086')).toEqual({ note: expect.stringMatching(/^a window id holds only while the window stays open/) });
    expect(testLine?.()).toBeUndefined();
  });

  it('drafts a line that names a missing window on replay, rather than the focused one', async () => {
    const line = declared().useWindow?.testLine?.({ id: '36086', title: 'Inbox', focused: true });
    const args = line !== undefined && 'args' in line ? line.args : '';
    const replay = (open: readonly { id: string; title: string }[]) =>
      (new Function('desktop', `return (async () => ${args})();`) as (desktop: unknown) => Promise<unknown>)({ windows: async () => open });
    expect(await replay([{ id: '9', title: 'Inbox' }])).toEqual({ id: '9', title: 'Inbox' });
    // useWindow refuses an id no window has: "the app has no window titled Inbox".
    expect(await replay([{ id: '9', title: 'Sent' }])).toBe('titled Inbox');
  });
});
