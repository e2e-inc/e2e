/** Evidence: masked screenshots. */

import { writeFileSync } from 'node:fs';
import { maskedPixels } from './observe.ts';
import type { BidiSession } from './session.ts';

/** Writes a masked viewport screenshot under the attempt directory and returns its relative path; the page's animations go on afterwards from where they were. */
export async function screenshot(session: BidiSession, label: string | undefined, signal: AbortSignal): Promise<string> {
  const { relative, absolute } = session.artifacts.reserve('screenshots', label, '.png');
  const { pixels } = await maskedPixels(session, await session.viewportSize(), signal, 'hold');
  writeFileSync(absolute, pixels.data);
  return relative;
}
