import { afterEach, describe, expect, it } from 'vitest';
import { desktop } from '../../src/engine.ts';
import { failure } from '../helpers/fake-driver.ts';
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

  it('reports a press that failed after it may have reached the app as one that may have committed', async () => {
    const { surface } = await launched({ pressBack: [failure('ACTION_FAILED', 'delivered_unverified')] });
    await expect(surface.back(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });
});
