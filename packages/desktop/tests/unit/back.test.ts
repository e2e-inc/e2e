import { afterEach, describe, expect, it } from 'vitest';
import { desktop } from '../../src/engine.ts';
import { failure, type Answer, type FakeDriver } from '../helpers/fake-driver.ts';
import { cleanUp, initialized, launched, operation } from '../helpers/surface.ts';

afterEach(cleanUp);

describe('app.back()', () => {
  it('is declared, so the agent and app.back() reach the app', () => {
    expect(desktop().session?.back).toBeTypeOf('function');
  });

  it("presses the Back menu item of the process the engine launched, named so a cut-off press is cancelled", async () => {
    const { surface, fake } = await launched();
    await surface.back(operation());
    const [call] = fake.of('pressBack');
    expect(call?.args[0]).toMatchObject({ pid: fake.pid, inputId: expect.any(Number), timeoutMs: expect.any(Number) });
    // Never a key: an app without Back would take it and report success.
    expect(fake.of('press')).toEqual([]);
  });

  it('refuses before app.open(), sending nothing', async () => {
    const { surface, fake } = await initialized();
    await expect(surface.back(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fake.of('pressBack')).toEqual([]);
  });

  it('refuses an app whose menu bar has no Back, and one whose Back is disabled, as the driver reports them', async () => {
    const none = failure('ACTION_NOT_SUPPORTED', 'not_delivered', "the app's menu bar has no Back command");
    const disabled = failure('ACTION_FAILED', 'not_delivered', 'Back in the Go menu is disabled');
    const { surface } = await launched({ pressBack: [none, disabled] });
    await expect(surface.back(operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('app.back(): the app') });
    await expect(surface.back(operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('is disabled') });
  });

  describe('with a window made active that is not the key window', () => {
    /** The app's two windows, `focused` the key window. */
    const windows = (focused: string) => (fake: FakeDriver): Answer => ({
      ok: true,
      data: [
        { id: 'w-main', title: 'Main', pid: fake.pid, is_focused: focused === 'w-main' },
        { id: 'w-inspector', title: 'Inspector', pid: fake.pid, is_focused: focused === 'w-inspector' },
      ],
    });

    it('refuses in the background, since the menu bar would go back in the key window', async () => {
      const { surface, fake } = await launched({ listWindows: [windows('w-main')] });
      await surface.activateWindow('w-inspector', operation());
      await expect(surface.back(operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/not the app's key window.*nothing was pressed/) });
      expect(fake.of('pressBack')).toEqual([]);
      // The key window itself goes back.
      await surface.activateWindow('w-main', operation());
      await surface.back(operation());
      expect(fake.of('pressBack')).toHaveLength(1);
    });

    it('brings the active window forward first with physicalInput', async () => {
      let key = 'w-main';
      const { surface, fake } = await launched(
        { listWindows: [(driver) => windows(key)(driver)], focusWindow: [() => ((key = 'w-inspector'), { ok: true, data: null })] },
        { options: { physicalInput: true } },
      );
      await surface.activateWindow('w-inspector', operation());
      await surface.back(operation());
      expect(fake.of('focusWindow').map((call) => call.args[1])).toEqual(['w-inspector']);
      expect(fake.calls.map((call) => call.method).filter((method) => method === 'focusWindow' || method === 'pressBack')).toEqual(['focusWindow', 'pressBack']);
    });
  });

  it('reports a press that failed after it may have reached the app as one that may have committed', async () => {
    const { surface } = await launched({ pressBack: [failure('ACTION_FAILED', 'delivered_unverified')] });
    await expect(surface.back(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });
});
