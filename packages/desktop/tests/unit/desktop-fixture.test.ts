/**
 * The `desktop` fixture's recording policy: how a test line from `e2e mcp`
 * writes `desktop.useWindow`, whose window id holds only while the window
 * stays open.
 */

import { describe, expect, it } from 'vitest';
import type { EngineFixtureContext, FixtureOperations } from '@e2e-dev/core/engine';
import { createDesktopFixture, type Desktop } from '../../src/desktop.ts';
import type { DesktopSurface } from '../../src/surface.ts';
import type { DesktopWindow } from '../../src/window-choice.ts';

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
    const inbox: DesktopWindow = { id: '36086', title: 'Inbox "all"', focused: true };
    const untitled: DesktopWindow = { id: '36090', title: '', focused: false };
    expect(testLine?.(inbox)).toEqual({ args: '"Inbox \\"all\\""' });
    expect(testLine?.(untitled)).toEqual({ note: expect.stringMatching(/^a window id holds only while the window stays open/) });
    // Plain JavaScript in run_code can pass a window with no title at all.
    expect(testLine?.({ id: '36091' })).toEqual({ note: expect.stringMatching(/^a window id/) });
    expect(testLine?.()).toBeUndefined();
  });

  it('keeps a title or a pattern as the test wrote it', () => {
    const testLine = declared().useWindow?.testLine;
    expect(testLine?.('Inbox')).toBeUndefined();
    expect(testLine?.(/^Inbox/)).toBeUndefined();
  });
});
