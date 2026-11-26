/** Held keyboard input through the actual browser fixture and native DOM events. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../src/browser.ts';
import type { WebEngine } from '../../src/engine.ts';
import { cleanupContext, openAttempt, openEngine } from '../helpers/attempt.ts';
describe('held keyboard input', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-held-keys-'));
  let engine: WebEngine;
  let browser: Browser;
  let close: () => Promise<void>;
  beforeAll(async () => {
    engine = await openEngine({ init: { projectRoot } });
  });
  beforeEach(async () => {
    const attempt = await openAttempt({ engine, attempt: { artifactsDir: projectRoot } });
    ({ browser, close } = attempt);
    await attempt.page.setContent('<h1 id="events"></h1>');
    await browser.evaluate(() => {
      for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
        if (!(event instanceof KeyboardEvent)) return;
        const output = document.querySelector('#events');
        if (output !== null) output.textContent += `${event.type}|${event.key}|${event.shiftKey}|${event.repeat};`;
      });
      return null;
    });
  });
  afterEach(() => close());
  afterAll(async () => {
    await engine.dispose!(cleanupContext());
    rmSync(projectRoot, { recursive: true, force: true });
  });
  it('keeps a modifier held across another key and releases it for later input', async () => {
    await browser.keyboard.down('Shift');
    await browser.keyboard.press('KeyB');
    await browser.keyboard.up('Shift');
    await browser.keyboard.press('KeyB');
    const events = await browser.evaluate(() => document.querySelector('#events')?.textContent ?? '');
    expect(events).toContain('keydown|B|true|false;');
    expect(events).toContain('keyup|Shift|false|false;');
    expect(events).toContain('keydown|b|false|false;');
  });
  it('marks a second down as repeat and a later release ends the held sequence', async () => {
    await browser.keyboard.down('a');
    await browser.keyboard.down('a');
    await browser.keyboard.up('a');
    await browser.keyboard.down('a');
    await browser.keyboard.up('a');
    const events = await browser.evaluate(() => document.querySelector('#events')?.textContent ?? '');
    expect(events).toBe('keydown|a|false|false;keydown|a|false|true;keyup|a|false|false;keydown|a|false|false;keyup|a|false|false;');
  });
});
