/** Compile-time assertions for the handle `desktop()` returns. */
import { desktop, type Desktop, type DesktopWindow } from '../../src/index.ts';

void (desktop().platform satisfies 'macos' | undefined);
void (desktop().isolation satisfies 'attempt' | undefined);

declare const fixture: Desktop;
declare const listed: DesktopWindow;
void (fixture.useWindow satisfies (window?: string | RegExp | DesktopWindow | { readonly id: string }) => Promise<void>);
void (() => fixture.useWindow(listed));
// @ts-expect-error a window is named by its title or picked from desktop.windows(), never by a bare number
void (() => fixture.useWindow(42));
