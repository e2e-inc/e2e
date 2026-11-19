import { describe, expect, it } from 'vitest';
import { FakeBidi, type Reply } from '../helpers/bidi-fake.ts';
import { BidiError } from '../../src/errors.ts';
import { acrossNavigations, TabWindows } from '../../src/driver/tab-windows.ts';

/** One window of the fake browser: its outer size, and the chrome a tab that fills it reads. */
interface FakeWindow {
  width: number;
  height: number;
  readonly chrome: { readonly width: number; readonly height: number };
  /** The largest the window grows each way; unbounded when undefined. */
  readonly limit?: { readonly width: number; readonly height: number };
}

/**
 * A browser whose tabs are in `windows`, by tab then window id: it reports
 * each window's size, tells its chrome to a tab that asks, and grows a
 * window as far as its limit allows.
 */
function browser(tabs: Readonly<Record<string, string>>, windows: Readonly<Record<string, FakeWindow>>): FakeBidi {
  const info = (clientWindow: string) => ({ clientWindow, active: true, state: 'normal', x: 0, y: 0, width: windows[clientWindow]!.width, height: windows[clientWindow]!.height });
  return new FakeBidi()
    .on('browsingContext.getTree', (params) => {
      const context = String(params['root']);
      return tabs[context] === undefined ? { error: 'no such frame', message: `Browsing Context with id ${context} not found` } : { result: { contexts: [{ context, clientWindow: tabs[context] }] } };
    })
    .on('browser.getClientWindows', () => ({ result: { clientWindows: Object.keys(windows).map(info) } }))
    .on('script.callFunction', (params) => chromeRead(windows[tabs[(params['target'] as { context: string }).context]!]!.chrome))
    .on('browser.setClientWindowState', (params) => {
      const window = windows[String(params['clientWindow'])]!;
      window.width = Math.min(Number(params['width']), window.limit?.width ?? Infinity);
      window.height = Math.min(Number(params['height']), window.limit?.height ?? Infinity);
      return { result: info(String(params['clientWindow'])) };
    });
}

/** What a tab that fills a window answers the read of that window's `chrome`. */
function chromeRead(chrome: FakeWindow['chrome']): Reply {
  return { result: { type: 'success', realm: 'r', result: { type: 'object', value: [['width', { type: 'number', value: chrome.width }], ['height', { type: 'number', value: chrome.height }]] } } };
}

/** The window sizes `fake` was asked for, in order. */
function grown(fake: FakeBidi): unknown[] {
  return fake.commands('browser.setClientWindowState').map((command) => command.params);
}

describe('TabWindows', () => {
  it('grows a window to the viewport plus its chrome, each way it falls short', async () => {
    const fake = browser({ tab: 'w' }, { w: { width: 1366, height: 768, chrome: { width: 0, height: 85 } } });
    const windows = new TabWindows(fake.connection);
    await windows.hold('tab', { width: 1280, height: 720 });
    expect(grown(fake)).toEqual([{ clientWindow: 'w', state: 'normal', width: 1366, height: 805 }]);
    await windows.hold('tab', { width: 1920, height: 1080 });
    expect(grown(fake).slice(1)).toEqual([{ clientWindow: 'w', state: 'normal', width: 1920, height: 1165 }]);
  });

  it('leaves a window that holds the viewport as it is, and shrinks none', async () => {
    const fake = browser({ tab: 'w' }, { w: { width: 1280, height: 945, chrome: { width: 0, height: 85 } } });
    const windows = new TabWindows(fake.connection);
    await windows.hold('tab', { width: 1280, height: 860 });
    await windows.hold('tab', { width: 320, height: 480 });
    expect(grown(fake)).toEqual([]);
  });

  it('reads a window\'s chrome once, in a sandbox realm, from the first tab sized in it', async () => {
    const fake = browser({ tab: 'w', popup: 'w', other: 'w2' }, { w: { width: 800, height: 600, chrome: { width: 0, height: 85 } }, w2: { width: 300, height: 241, chrome: { width: 2, height: 41 } } });
    const windows = new TabWindows(fake.connection);
    await windows.hold('tab', { width: 800, height: 600 });
    await windows.hold('tab', { width: 900, height: 700 });
    await windows.hold('popup', { width: 900, height: 700 });
    await windows.hold('other', { width: 900, height: 700 });
    expect(fake.commands('script.callFunction').map((command) => command.params['target'])).toEqual([{ context: 'tab', sandbox: 'e2e-window' }, { context: 'other', sandbox: 'e2e-window' }]);
    expect(grown(fake)).toEqual([
      { clientWindow: 'w', state: 'normal', width: 800, height: 685 },
      { clientWindow: 'w', state: 'normal', width: 900, height: 785 },
      { clientWindow: 'w2', state: 'normal', width: 902, height: 741 },
    ]);
  });

  it('refuses a viewport the window cannot grow to hold, naming what it shows, and puts the window back', async () => {
    const window = { width: 1280, height: 945, chrome: { width: 0, height: 85 }, limit: { width: 2560, height: 1050 } };
    const fake = browser({ tab: 'w' }, { w: window });
    const windows = new TabWindows(fake.connection);
    await expect(windows.hold('tab', { width: 800, height: 1400 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      retryable: false,
      message: 'the browser window cannot hold a 800x1400 viewport: it shows at most 965 pixels of the page\'s height, and pointer input reaches only what the window shows. '
        + 'A headed window ends at its display, a headless one at the browser\'s largest window; set a viewport that fits',
    });
    expect(grown(fake)).toEqual([{ clientWindow: 'w', state: 'normal', width: 1280, height: 1485 }, { clientWindow: 'w', state: 'normal', width: 1280, height: 945 }]);
    expect(window).toMatchObject({ width: 1280, height: 945 });
    await expect(windows.hold('tab', { width: 3000, height: 2000 })).rejects.toMatchObject({
      message: expect.stringContaining('it shows at most 2560 pixels of the page\'s width and 965 pixels of the page\'s height'),
    });
    await windows.hold('tab', { width: 2560, height: 965 });
  });

  it('reads a tab that closed, and one whose window is listed no more, as closed before it asks either anything', async () => {
    const fake = browser({ tab: 'gone' }, {});
    const windows = new TabWindows(fake.connection);
    const closed = { code: 'NODE_STALE', retryable: true, message: 'the tab closed while its window was sized' };
    await expect(windows.hold('closed', { width: 100, height: 100 })).rejects.toMatchObject(closed);
    await expect(windows.hold('tab', { width: 100, height: 100 })).rejects.toMatchObject(closed);
    expect(fake.commands('script.callFunction')).toEqual([]);
    expect(grown(fake)).toEqual([]);
  });

  it.each([
    ['its chrome was read', 'script.callFunction', { error: 'no such frame', message: 'Browsing Context with id tab not found' }],
    ['it grew, the close done', 'browser.setClientWindowState', { error: 'no such client window', message: 'Client window with id w not found' }],
    ['it grew, the close under way', 'browser.setClientWindowState', { error: 'unknown error', message: '[Exception... "Failure"  nsresult: "0x80004005 (NS_ERROR_FAILURE)"]' }],
  ] as const)('reads a window that closed while %s as closed, whatever the browser answered', async (_when, method, reply) => {
    const tabs: Record<string, string> = { tab: 'w' };
    const fake = browser(tabs, { w: { width: 500, height: 600, chrome: { width: 0, height: 85 } } });
    fake.on(method, () => {
      delete tabs['tab'];
      return reply;
    });
    await expect(new TabWindows(fake.connection).hold('tab', { width: 1280, height: 720 })).rejects.toMatchObject({
      code: 'NODE_STALE',
      retryable: true,
      message: 'the tab closed while its window was sized',
      cause: { error: reply.error },
    });
  });

  it('keeps the browser\'s own failure for a window that is still open', async () => {
    const fake = browser({ tab: 'w' }, { w: { width: 500, height: 600, chrome: { width: 0, height: 85 } } });
    fake.on('browser.setClientWindowState', { error: 'unknown error', message: 'the window manager refused' });
    await expect(new TabWindows(fake.connection).hold('tab', { width: 1280, height: 720 })).rejects.toMatchObject({ error: 'unknown error', detail: 'the window manager refused' });
  });

  it('reads the chrome in the tab\'s next document when a navigation replaced the one it was read in', async () => {
    const chrome = { width: 2, height: 41 };
    const fake = browser({ tab: 'w' }, { w: { width: 500, height: 600, chrome } });
    let replaced = 2;
    fake.on('script.callFunction', () => (replaced-- > 0
      ? { error: 'no such frame', message: 'DiscardedBrowsingContextError: Actor \'MessageHandlerFrame\' destroyed before query \'MessageHandlerFrameParent:sendCommand\' was resolved' }
      : chromeRead(chrome)));
    await new TabWindows(fake.connection).hold('tab', { width: 1280, height: 720 });
    expect(fake.commands('script.callFunction')).toHaveLength(3);
    expect(grown(fake)).toEqual([{ clientWindow: 'w', state: 'normal', width: 1282, height: 761 }]);
  });
});

describe('acrossNavigations', () => {
  /** A browser with tab `tab` open until `closed` is set. */
  function oneTab(): { fake: FakeBidi; close(): void } {
    let closed = false;
    const fake = new FakeBidi().on('browsingContext.getTree', () => (closed ? { error: 'no such frame', message: 'Browsing Context with id tab not found' } : { result: { contexts: [{ context: 'tab' }] } }));
    return { fake, close: () => void (closed = true) };
  }

  /** A command that fails with each of `failures` in turn, then answers `done`. */
  function failing(failures: unknown[]): { command: () => Promise<string>; sent(): number } {
    let sent = 0;
    return {
      command: async () => {
        sent += 1;
        if (failures.length > 0) throw failures.shift();
        return 'done';
      },
      sent: () => sent,
    };
  }

  const replaced = (): BidiError => new BidiError('browsingContext.setViewport', 'no such frame', 'DiscardedBrowsingContextError');

  it('sends a command again each time a navigation replaced the document under it, while the tab is open', async () => {
    const { fake } = oneTab();
    const { command, sent } = failing([replaced(), replaced()]);
    await expect(acrossNavigations(fake.connection, 'tab', command)).resolves.toBe('done');
    expect(sent()).toBe(3);
    expect(fake.commands('browsingContext.getTree').map((sentCommand) => sentCommand.params)).toEqual([{ root: 'tab', maxDepth: 0 }, { root: 'tab', maxDepth: 0 }]);
  });

  it('keeps the failure of a command whose tab closed, and of one that failed for another reason, and sends neither again', async () => {
    const { fake, close } = oneTab();
    const refused = new BidiError('browsingContext.setViewport', 'unknown error', 'no viewport');
    const other = failing([refused]);
    await expect(acrossNavigations(fake.connection, 'tab', other.command)).rejects.toBe(refused);
    expect(fake.commands('browsingContext.getTree')).toEqual([]);
    close();
    const gone = replaced();
    const closed = failing([gone]);
    await expect(acrossNavigations(fake.connection, 'tab', closed.command)).rejects.toBe(gone);
    expect([other.sent(), closed.sent()]).toEqual([1, 1]);
  });
});
