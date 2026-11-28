/**
 * Launching and quitting real apps: the shapes of app that a launcher which
 * waits on every window, or on the main process's inspector, cannot start.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { Transformer } from '@napi-rs/image';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineAttemptContext, OperationContext } from '@e2e-dev/core/engine';
import { AppProcess, type LaunchSetup } from '../../src/app-process.ts';
import { Budget } from '../../src/budget.ts';
import { screenshotFile, withPixels } from '../../src/capture.ts';
import { DevTools } from '../../src/devtools.ts';
import { ensureFfmpeg } from '../../src/ffmpeg.ts';
import { readWindow } from '../../src/locate.ts';
import { resolveOptions } from '../../src/options.ts';
import { Recorder } from '../../src/video.ts';
import { DialogRouter } from '../../src/dialogs.ts';
import { Windows, type AppWindow } from '../../src/windows.ts';
import { electronBinary } from './electron-binary.ts';

const LOADED = `new BrowserWindow({ show: false }).loadURL('data:text/html,<title>Loaded</title><h1>Loaded</h1>')`;
/** Whether a window whose pixels a test reads is shown: Windows captures nothing of a hidden one, and Linux draws on a virtual display. Hidden on macOS, where a shown one would take the developer's screen. */
const SHOWN = process.platform !== 'darwin';
/**
 * How long a test keeps a window on screen before the app hides it. A window
 * hidden the moment it loaded can have drawn nothing yet, and a capture of
 * one sometimes never returns on Windows and Linux: a gap of its own, which
 * these tests leave out.
 */
const SHOWN_MS = 1000;
const directories: string[] = [];
const apps: AppProcess[] = [];

interface Launched {
  readonly app: AppProcess;
  readonly windows: Windows;
  readonly dialogs: DialogRouter;
  readonly logs: string[];
  readonly directory: string;
  /** Launches; with `spentMs`, after the operation spent that much of its time, as a restart's quit does. */
  launch(timeoutMs?: number, signal?: AbortSignal, spentMs?: number): Promise<void>;
}

/** An app whose main script runs `body` once Electron is ready, with `electron`'s exports in scope. */
function appWith(body: string, launchArguments: readonly string[] = []): Launched {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-electron-launch-'));
  directories.push(directory);
  writeFileSync(path.join(directory, 'main.js'), `const { app, BrowserWindow, WebContentsView } = require('electron');\n${body}\n`);
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'launch-test', main: 'main.js' }));
  const windows = new Windows();
  const dialogs = new DialogRouter();
  const app = new AppProcess(resolveOptions({}), windows, dialogs);
  apps.push(app);
  const logs: string[] = [];
  const attempt = { appLog: (entry: { readonly text: string }) => void logs.push(entry.text), navigation: () => undefined, environment: () => undefined } as unknown as EngineAttemptContext;
  const setup: LaunchSetup = { executable: electronBinary(), projectRoot: directory, app: { appPath: '.', launchArguments }, env: process.env, userDataDir: path.join(directory, 'data'), attempt };
  return {
    app,
    windows,
    dialogs,
    logs,
    directory,
    launch: async (timeoutMs = 20_000, signal = new AbortController().signal, spentMs) => {
      const operation = { signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' } as OperationContext;
      if (spentMs === undefined) return await app.launch(setup, operation);
      const budget = new Budget(operation, 'app.open');
      await new Promise((resolve) => setTimeout(resolve, spentMs));
      await app.launch(setup, operation, budget);
    },
  };
}

/** The processes started from an app's directory that are still alive. */
function processesOf(directory: string): string[] {
  if (process.platform === 'win32') return [];
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(directory));
}

async function gone(directory: string): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (processesOf(directory).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.quit({ timeoutMs: 1000 }, 1000);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('launch', () => {
  it('opens an app beside a window that loads nothing, which is no window to read', async () => {
    const { app, windows, launch } = appWith(`app.whenReady().then(() => { new BrowserWindow({ show: false }); ${LOADED}; });`);
    await launch();
    expect(windows.open()).toHaveLength(1);
    expect(await windows.require().page.title()).toBe('Loaded');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length, undefined)).toBe(2);
  });

  it('opens an app with a view that loads nothing', async () => {
    const { windows, launch } = appWith(`app.whenReady().then(() => { const window = new BrowserWindow({ show: false }); window.contentView.addChildView(new WebContentsView()); window.loadURL('data:text/html,<title>Loaded</title>'); });`);
    await launch();
    expect(windows.open()).toHaveLength(1);
  });

  it('waits for a window that loads its page late, and makes a blank one a window once it loads', async () => {
    const { app, windows, launch } = appWith(`app.whenReady().then(() => { const late = new BrowserWindow({ show: false }); setTimeout(() => late.loadURL('data:text/html,<title>Late</title>'), 700); globalThis.late = late; });`);
    await launch();
    expect(await windows.require().page.title()).toBe('Late');
    await app.evaluate(({ BrowserWindow }) => void new BrowserWindow({ show: false }).loadURL('data:text/html,<title>Second</title>'), undefined);
    await expect.poll(() => windows.open().length).toBe(2);
  });

  it('waits for a first page its server is slow to send', async () => {
    const { windows, launch } = appWith(`app.whenReady().then(() => {
      const server = require('node:http').createServer((_request, response) => setTimeout(() => response.end('<title>Slow</title><h1>Slow</h1>'), 800));
      server.listen(0, '127.0.0.1', () => new BrowserWindow({ show: false }).loadURL('http://127.0.0.1:' + server.address().port + '/'));
    });`);
    await launch();
    const { page } = windows.require();
    const { result } = await page.session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    expect(result.value).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await page.title()).toBe('Slow');
  });

  it('opens on the window that loads when the first one closes before it ever does', async () => {
    const { windows, launch } = appWith(`app.on('window-all-closed', () => {}); app.whenReady().then(() => {
      const server = require('node:http').createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.write('<title>Splash</title><p>partial'); });
      server.listen(0, '127.0.0.1', () => {
        const splash = new BrowserWindow({ show: false });
        splash.loadURL('http://127.0.0.1:' + server.address().port + '/').catch(() => {});
        setTimeout(() => splash.destroy(), 600);
        setTimeout(() => { ${LOADED}; }, 900);
      });
    });`);
    await launch(5000);
    expect(await windows.require().page.title()).toBe('Loaded');
  });

  it('reads the window that loaded, not a first one still on its way', async () => {
    const { windows, launch } = appWith(`app.whenReady().then(() => {
      const server = require('node:http').createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.write('<title>Splash</title><p>partial'); });
      server.listen(0, '127.0.0.1', () => {
        new BrowserWindow({ show: false }).loadURL('http://127.0.0.1:' + server.address().port + '/').catch(() => {});
        setTimeout(() => { ${LOADED}; }, 500);
      });
    });`);
    await launch(5000);
    expect(windows.open()).toHaveLength(2);
    expect(await windows.require().page.title()).toBe('Loaded');
  });

  it('quotes a last stderr line that has no newline', async () => {
    const { launch } = appWith(`process.stderr.write('license failure'); process.exit(3);`);
    expect(String(await launch().then(() => undefined, (error: unknown) => error))).toMatch(/license failure/);
  });

  it('says how the app ended, with what it wrote to stderr, when it quits before a window', async () => {
    const { directory, launch } = appWith(`console.error('license check failed'); process.exit(3);`);
    const failure = await launch().then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 'INVALID_STATE' });
    expect(String(failure)).toMatch(/the app quit before it opened a window \(with exit code 3\)\. The app wrote to stderr:\n(.*\n)*license check failed/);
    expect(await gone(directory)).toBe(true);
  });

  it('says a window that loaded nothing is why no window opened, and leaves no process', async () => {
    const { directory, launch } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: false }));`);
    const failure = await launch(2000).then(() => undefined, (error: unknown) => error);
    expect(String(failure)).toMatch(/opened no window that loaded a page within \d+ms: 1 window has loaded nothing yet/);
    expect(await gone(directory)).toBe(true);
  });

  it('says why a launch failed when the operation spent part of its time before it, as a restart\'s quit does', async () => {
    const { launch } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: false }));`);
    // The operation's signal ends with its time, as the runner's does; the quit before the launch spent half of it.
    const failure = await launch(4000, AbortSignal.timeout(4000), 2000).then(() => undefined, (error: unknown) => error);
    expect(failure).not.toMatchObject({ code: 'CANCELLED' });
    expect(String(failure)).toMatch(/1 window has loaded nothing yet/);
  });

  it('starts no app when the operation spent all its time before the launch', async () => {
    const { directory, launch } = appWith(`require('node:fs').writeFileSync(require('node:path').join(__dirname, 'started'), '1'); app.whenReady().then(() => { ${LOADED}; });`);
    const failure = await launch(500, AbortSignal.timeout(5000), 700).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(existsSync(path.join(directory, 'started'))).toBe(false);
  });

  it('kills the whole app when its launch is cancelled', async () => {
    const { directory, launch } = appWith(`app.whenReady().then(() => { new BrowserWindow({ show: false }); require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ready'), '1'); });`);
    const cancel = new AbortController();
    const launching = launch(20_000, cancel.signal).then(() => undefined, (error: unknown) => error);
    await expect.poll(() => existsSync(path.join(directory, 'ready')), { timeout: 10_000 }).toBe(true);
    cancel.abort();
    expect(await launching).toMatchObject({ code: 'CANCELLED' });
    expect(await gone(directory)).toBe(true);
  });

  it('says the binary could not be started', async () => {
    const launched = appWith(`app.quit();`);
    const windows = new Windows();
    const app = new AppProcess(resolveOptions({}), windows, new DialogRouter());
    const attempt = { appLog: () => undefined, navigation: () => undefined, environment: () => undefined } as unknown as EngineAttemptContext;
    const setup: LaunchSetup = { executable: path.join(launched.directory, 'no-such-binary'), projectRoot: launched.directory, app: { appPath: '.' }, env: process.env, userDataDir: path.join(launched.directory, 'data'), attempt };
    const failure = await app.launch(setup, { signal: new AbortController().signal, timeoutMs: 5000, runId: 'run', attemptId: 'attempt', origin: 'test' } as OperationContext).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/could not launch .*no-such-binary with \.: spawn .* ENOENT/) });
  });
});

describe('quit', () => {
  it('quits the app through its own quit handlers, and kills one that refuses to go', async () => {
    const polite = appWith(`app.on('will-quit', () => require('node:fs').writeFileSync(require('node:path').join(__dirname, 'quit-handled'), '1')); app.whenReady().then(() => { ${LOADED}; });`);
    await polite.launch();
    await polite.app.quit({ timeoutMs: 5000 }, 5000);
    expect(processesOf(polite.directory)).toEqual([]);
    expect(() => execFileSync('ls', [path.join(polite.directory, 'quit-handled')])).not.toThrow();

    const stubborn = appWith(`app.on('before-quit', (event) => event.preventDefault()); app.whenReady().then(() => { ${LOADED}; });`);
    await stubborn.launch();
    const started = Date.now();
    await stubborn.app.quit({ timeoutMs: 5000 }, 300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await gone(stubborn.directory)).toBe(true);
  });

  it('notices an app that quits on its own, and says how', async () => {
    const { app, windows, launch } = appWith(`app.whenReady().then(() => { ${LOADED}; });`);
    await launch();
    await app.evaluate(({ app: main }) => void setTimeout(() => main.exit(4), 20), undefined);
    await expect.poll(() => app.running).toBe(false);
    expect(windows.open()).toEqual([]);
    expect(app.notRunning().message).toMatch(/quit on its own with exit code 4/);
  });

  it('closes one window past its beforeunload guard', async () => {
    const { app, windows, launch } = appWith(`app.whenReady().then(() => { ${LOADED}; new BrowserWindow({ show: false }).loadURL('data:text/html,<title>Guarded</title><script>onbeforeunload = (event) => event.preventDefault()</script>'); });`);
    await launch();
    await expect.poll(() => windows.open().length).toBe(2);
    const guarded = windows.open().find((window) => window.page.url().includes('Guarded'))!;
    // Chromium honours the guard only in a page its user has acted in; then an ordinary close is held back.
    await guarded.page.mouse.click(10, 10);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Guarded')?.close(), undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(guarded.page.isClosed()).toBe(false);
    await app.closeWindow(guarded.page);
    expect(guarded.page.isClosed()).toBe(true);
    expect(windows.open()).toHaveLength(1);
  });
});

describe('windows', () => {
  it('goes back to the window that opened the one that closed, not the one shown before it', async () => {
    const { app, windows, launch } = appWith(`app.on('web-contents-created', (_event, contents) => contents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false } }))); app.whenReady().then(() => { ${LOADED}; });`);
    await launch();
    const [first] = windows.open();
    await app.evaluate(({ BrowserWindow }) => void new BrowserWindow({ show: false }).loadURL('data:text/html,<title>Second</title>'), undefined);
    await expect.poll(() => windows.open().length).toBe(2);
    const second = windows.open()[1]!;
    await first!.page.session.send('Runtime.evaluate', { expression: 'void window.open("data:text/html,<title>Popup</title>")', userGesture: true });
    await expect.poll(() => windows.open().length).toBe(3);
    const popup = windows.open()[2]!;
    windows.activate(second);
    windows.activate(popup);
    await app.closeWindow(popup.page);
    expect(windows.current()).toBe(first);
    // A window the main process opened has no opener: the one shown before it is next.
    windows.activate(second);
    await app.closeWindow(second.page);
    expect(windows.current()).toBe(first);
  });

  it('starts the app with the switches of app.launchArguments, Chromium\'s as well as its own', async () => {
    const { app, launch } = appWith(`app.whenReady().then(() => { ${LOADED}; });`, ['--lang=de', '--no-update-check']);
    await launch();
    expect(await app.evaluate(({ app: main }) => [main.commandLine.getSwitchValue('lang'), process.argv.includes('--no-update-check')], undefined)).toEqual(['de', true]);
  });
});

describe('dialogs', () => {
  const ASKING = `new BrowserWindow({ show: false }).loadURL('data:text/html,<title>Asking</title><script>setTimeout(() => { alert("Heads up"); document.title = String(confirm("Sure?")); }, 50)</script>')`;

  it('dismisses a dialog nothing answers, and holds it as the failure of the next step', async () => {
    const { windows, dialogs, launch } = appWith(`app.whenReady().then(() => { ${ASKING}; });`);
    await launch();
    await expect.poll(() => windows.require().page.title()).toBe('false');
    expect(dialogs.take()).toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/^unhandled alert dialog: Heads up; answer it with electron\.onDialog/) });
    // Once: the step after the one it failed goes on.
    expect(dialogs.take()).toBeUndefined();
  });

  it('answers every dialog as the newest handler says, until it is removed', async () => {
    const { windows, dialogs, launch } = appWith(`app.whenReady().then(() => { ${ASKING}; });`);
    dialogs.add('dismiss');
    const seen: string[] = [];
    const off = dialogs.add(async (dialog) => {
      seen.push(`${dialog.type}: ${dialog.message}`);
      await dialog.accept();
    });
    await launch();
    await expect.poll(() => windows.require().page.title()).toBe('true');
    expect(seen).toEqual(['alert: Heads up', 'confirm: Sure?']);
    expect(dialogs.take()).toBeUndefined();
    off();
    await windows.require().page.session.send('Runtime.evaluate', { expression: 'document.title = String(confirm("Again?"))' });
    expect(await windows.require().page.title()).toBe('false');
    expect(dialogs.take()).toBeUndefined();
  });

  it('dismisses a dialog its handler leaves open or throws on, and fails the next step', async () => {
    const { windows, dialogs, launch } = appWith(`app.whenReady().then(() => { ${ASKING}; });`);
    const off = dialogs.add(() => undefined);
    await launch();
    await expect.poll(() => windows.require().page.title()).toBe('false');
    expect(dialogs.take()).toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/returned without calling accept or dismiss for alert dialog: Heads up/) });
    off();
    dialogs.add(() => {
      throw new Error('boom');
    });
    await windows.require().page.session.send('Runtime.evaluate', { expression: 'document.title = String(confirm("Again?"))' });
    expect(await windows.require().page.title()).toBe('false');
    expect(dialogs.take()).toMatchObject({ code: 'ENGINE_FAILURE', message: 'dialog handler failed: boom' });
  });
});

describe('electron.evaluate', () => {
  it('returns a number JSON has no word for, and refuses an argument that is not JSON as the test\'s own mistake', async () => {
    const { app, launch } = appWith(`app.whenReady().then(() => { ${LOADED}; });`);
    await launch();
    expect(await app.evaluate(() => Number.NaN, undefined)).toBeNaN();
    expect(await app.evaluate(() => Number.POSITIVE_INFINITY, undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(await app.evaluate(({ BrowserWindow }) => typeof BrowserWindow.getAllWindows()[0], undefined)).toBe('object');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0], undefined)).toBeTypeOf('object');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(await app.evaluate(() => 1, cyclic).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await app.evaluate(() => 1, 10n).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await app.evaluate(() => { throw new Error('mine'); }, undefined).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: 'EVALUATE_FAILED', message: 'electron.evaluate: Error: mine' });
  });
});

describe('downloads', () => {
  it.skipIf(process.platform === 'win32')('saves inside the attempt a download from a session the app made before any window used it', async () => {
    const launched = appWith(`app.setPath('downloads', require('node:path').join(__dirname, 'outside'));
      app.whenReady().then(() => {
        require('electron').session.fromPartition('persist:later');
        const server = require('node:http').createServer((request, response) => {
          if (request.url !== '/file') return response.end('<title>Loaded</title>');
          response.setHeader('Content-Disposition', 'attachment; filename="later.txt"');
          response.end('later');
        });
        server.listen(0, '127.0.0.1', () => new BrowserWindow({ show: false }).loadURL('http://127.0.0.1:' + server.address().port + '/'));
      });`);
    await launched.launch();
    const origin = new URL(launched.windows.require().page.url()).origin;
    await launched.app.evaluate(({ BrowserWindow, session }, url) => {
      new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition('persist:later') } }).webContents.downloadURL(url);
    }, `${origin}/file`);
    const downloads = path.join(launched.directory, 'data', 'Downloads');
    await expect.poll(() => (existsSync(downloads) ? readdirSync(downloads) : [])).toContain('later.txt');
    expect(existsSync(path.join(launched.directory, 'outside', 'later.txt'))).toBe(false);
  });
});

describe('an app with no inspector', () => {
  it.skipIf(process.platform === 'win32')('opens and saves a download inside the attempt', async () => {
    const launched = appWith(`app.whenReady().then(() => {
      const server = require('node:http').createServer((request, response) => {
        if (request.url !== '/file') return response.end('<title>Loaded</title><a href="/file">file</a>');
        response.setHeader('Content-Disposition', 'attachment; filename="saved.txt"');
        response.end('saved');
      });
      server.listen(0, '127.0.0.1', () => new BrowserWindow({ show: false }).loadURL('http://127.0.0.1:' + server.address().port + '/'));
    });`);
    // Drops the engine's first switch, --inspect=0, as a binary with the EnableNodeCliInspectArguments fuse off ignores it.
    const wrapper = path.join(launched.directory, 'no-inspector');
    writeFileSync(wrapper, `#!/bin/sh\nshift\nexec "${electronBinary()}" "$@"\n`, { mode: 0o755 });
    const attempt = { appLog: (entry: { readonly text: string }) => void launched.logs.push(entry.text), navigation: () => undefined, environment: () => undefined } as unknown as EngineAttemptContext;
    const data = path.join(launched.directory, 'data');
    const setup: LaunchSetup = { executable: wrapper, projectRoot: launched.directory, app: { appPath: '.' }, env: process.env, userDataDir: data, attempt };
    await launched.app.launch(setup, { signal: new AbortController().signal, timeoutMs: 20_000, runId: 'run', attemptId: 'attempt', origin: 'test' } as OperationContext);
    expect(launched.logs.join('\n')).toMatch(/opened no inspector/);
    expect(await launched.app.evaluate(() => 1, undefined).then(() => undefined, (error: unknown) => error)).toMatchObject({ message: expect.stringMatching(/opened no inspector/) });
    await launched.windows.require().page.evaluate(() => document.querySelector('a')?.click());
    await expect.poll(() => (existsSync(path.join(data, 'Downloads')) ? readdirSync(path.join(data, 'Downloads')) : [])).toContain('saved.txt');
  });

  it.skipIf(process.platform === 'win32')('takes its own directory from the window the launch ends on, when the splash it waited for closes during setup', async () => {
    const launched = appWith(`app.on('window-all-closed', () => {}); app.whenReady().then(() => {
      const splash = new BrowserWindow({ show: false });
      splash.webContents.once('did-finish-load', () => setTimeout(() => {
        splash.destroy();
        new BrowserWindow({ show: false }).loadFile(require('node:path').join(__dirname, 'bundle', 'ui', 'index.html'));
      }, 150));
      splash.loadFile(require('node:path').join(__dirname, 'bundle', 'splash', 'index.html'));
    });`);
    for (const part of ['splash', 'ui']) {
      mkdirSync(path.join(launched.directory, 'bundle', part), { recursive: true });
      writeFileSync(path.join(launched.directory, 'bundle', part, 'index.html'), `<title>${part}</title>`);
    }
    // A packaged app's binary: no app path on the command line, and no inspector to report one.
    const wrapper = path.join(launched.directory, 'packaged');
    writeFileSync(wrapper, `#!/bin/sh\nshift\nexec "${electronBinary()}" "${launched.directory}" "$@"\n`, { mode: 0o755 });
    const attempt = { appLog: (entry: { readonly text: string }) => void launched.logs.push(entry.text), navigation: () => undefined, environment: () => undefined } as unknown as EngineAttemptContext;
    const setup: LaunchSetup = { executable: wrapper, projectRoot: launched.directory, app: {}, env: process.env, userDataDir: path.join(launched.directory, 'data'), attempt };
    await launched.app.launch(setup, { signal: new AbortController().signal, timeoutMs: 20_000, runId: 'run', attemptId: 'attempt', origin: 'test' } as OperationContext);
    expect(await launched.windows.require().page.title()).toBe('ui');
    expect(launched.app.appDirectory).toBe(realpathSync(path.join(launched.directory, 'bundle', 'ui')));
  });
});

/**
 * An app whose one window shows `page`, at `scale` device pixels per CSS pixel. The page is a file beside the main
 * script, so none of its text becomes part of the script's code.
 */
function pageApp(page: string, { width, height, scale }: { readonly width: number; readonly height: number; readonly scale: number }): Launched {
  const launched = appWith(
    `app.whenReady().then(() => new BrowserWindow({ show: ${SHOWN}, width: ${width}, height: ${height} }).loadFile(require('node:path').join(__dirname, 'page.html')));`,
    [`--force-device-scale-factor=${scale}`],
  );
  writeFileSync(path.join(launched.directory, 'page.html'), page);
  return launched;
}

describe('pixels', () => {
  it('withholds the pixels when the page takes the masks away', async () => {
    const page = `<body style="margin:0"><iframe style="border:0;width:300px;height:200px" srcdoc="<body style=margin:0;background:red>"></iframe><script>new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) if (node.popover) node.remove(); }).observe(document.documentElement, { childList: true });</script></body>`;
    const { windows, launch } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: ${SHOWN}, width: 300, height: 200 }).loadURL('data:text/html,' + ${JSON.stringify(encodeURIComponent(page))}));`);
    await launch();
    const window = windows.require();
    const devtools = new DevTools();
    const result = await withPixels(devtools, await readWindow(devtools, window), { root: { ref: { id: 'window', revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } });
    expect(result.pixels).toBeUndefined();
    expect(result.maskedRegionCount).toBe(1);
  });

  it('masks a nested document in a page its root zooms', async () => {
    const page = `<html style="zoom:2"><body style="margin:0"><div style="height:20px"></div><iframe style="border:0;margin-left:30px;width:100px;height:50px" srcdoc="<body style=margin:0;background:red>"></iframe></body></html>`;
    const { windows, launch } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: ${SHOWN}, width: 400, height: 300 }).loadURL('data:text/html,' + ${JSON.stringify(encodeURIComponent(page))}));`);
    await launch();
    const window = windows.require();
    const devtools = new DevTools();
    const { pixels } = await withPixels(devtools, await readWindow(devtools, window), { root: { ref: { id: 'window', revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } });
    const rgba = new Transformer(pixels!.data).rawPixelsSync();
    let red = 0;
    for (let at = 0; at < rgba.length; at += rgba.length / (pixels!.width * pixels!.height)) if (rgba[at]! > 200 && rgba[at + 1]! < 50) red += 1;
    expect(red).toBe(0);
  });

  /** An observation with pixels of a window showing `page`, and how many of its pixels are red. */
  async function observed(page: string): Promise<{ readonly pixels: boolean; readonly red: number; readonly masked: number | undefined }> {
    const { windows, launch } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: ${SHOWN}, width: 300, height: 200 }).loadURL('data:text/html,' + ${JSON.stringify(encodeURIComponent(page))}));`);
    await launch();
    const window = windows.require();
    const devtools = new DevTools();
    const { pixels, maskedRegionCount } = await withPixels(devtools, await readWindow(devtools, window), { root: { ref: { id: 'window', revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } });
    if (pixels === undefined) return { pixels: false, red: 0, masked: maskedRegionCount };
    const rgba = new Transformer(pixels.data).rawPixelsSync();
    let red = 0;
    for (let at = 0; at < rgba.length; at += rgba.length / (pixels.width * pixels.height)) if (rgba[at]! > 200 && rgba[at + 1]! < 50) red += 1;
    return { pixels: true, red, masked: maskedRegionCount };
  }

  const RED_FRAME = `<iframe style="border:0;width:200px;height:100px" srcdoc="<body style=margin:0;background:red>"></iframe>`;
  /** Runs `reaction` in the page the moment the masks are placed. */
  const onMasks = (reaction: string): string => `<script>new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) if (node.popover) { ${reaction} } }).observe(document.documentElement, { childList: true });</script>`;

  it('paints its masks over the app\'s own !important styles', async () => {
    for (const rule of ['[popover]{opacity:0 !important}', 'div{opacity:0 !important}', 'div{background:transparent !important}', 'div{visibility:hidden !important}']) {
      expect(await observed(`<style>${rule}</style><body style="margin:0">${RED_FRAME}</body>`), rule).toEqual({ pixels: true, red: 0, masked: 1 });
    }
  });

  it('refuses a screenshot when a password field appears, or a masked element moves, after the masks are placed', async () => {
    const refusal = async (reaction: string): Promise<string> => {
      const { windows, launch, directory } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: ${SHOWN}, width: 300, height: 200 }).loadURL('data:text/html,' + ${JSON.stringify(encodeURIComponent(`<body style="margin:0">${RED_FRAME}${onMasks(reaction)}</body>`))}));`);
      await launch();
      return String(await screenshotFile(new DevTools(), windows.require(), directory, 'shot.png', () => undefined).then(() => 'taken', (error: unknown) => error));
    };
    expect(await refusal(`const field = document.createElement('input'); field.type = 'password'; document.body.append(field);`)).toMatch(/appeared while the screenshot was taken/);
    expect(await refusal(`document.querySelector('iframe').style.marginLeft = '60px';`)).toMatch(/moved while the screenshot was taken/);
  });

  it('writes no screenshot of a window that left the app while it was captured', async () => {
    const { windows, launch, directory } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: ${process.platform === 'linux'}, width: 300, height: 200 }).loadURL('data:text/html,<title>Loaded</title>'));`);
    await launch();
    // In the app when the screenshot is asked for, gone from it once the capture is done.
    const answers = [undefined, 'the window left the app'];
    const refused = await screenshotFile(new DevTools(), windows.require(), directory, 'left.png', () => answers.shift()).then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/left the app/) });
    expect(existsSync(path.join(directory, 'screenshots', 'left.png'))).toBe(false);
  });

  it('writes no screenshot when the window loaded another document while it was captured', async () => {
    const { windows, launch, directory } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: ${process.platform === 'linux'}, width: 300, height: 200 }).loadURL('data:text/html,<title>Loaded</title>'));`);
    await launch();
    const window = windows.require();
    // In the app at both checks, with another document loaded in between, as two navigations would leave it.
    const refused = await screenshotFile(new DevTools(), window, directory, 'swapped.png', () => {
      setTimeout(() => window.page.documentChanged(), 0);
      return undefined;
    }).then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/loaded another document/) });
    expect(existsSync(path.join(directory, 'screenshots', 'swapped.png'))).toBe(false);
  });

  it('gives each of two captures taken at once its own masks', async () => {
    const { windows, launch } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: ${SHOWN}, width: 300, height: 200 }).loadURL('data:text/html,<body style="margin:0"><iframe style="border:0;width:300px;height:200px" srcdoc="<body style=margin:0;background:red>"></iframe></body>'));`);
    await launch();
    const window = windows.require();
    const devtools = new DevTools();
    const raw = await readWindow(devtools, window);
    const snapshot = { root: { ref: { id: 'window', revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } };
    const captures = await Promise.all([1, 2, 3].map(() => withPixels(devtools, raw, snapshot)));
    for (const { pixels } of captures) {
      const rgba = new Transformer(pixels!.data).rawPixelsSync();
      expect([rgba[0], rgba[1], rgba[2]]).toEqual([0, 0, 0]);
    }
  });

  it('captures the part of the document the window shows, one image pixel per CSS pixel, on a dense display', async () => {
    const page = `<body style="margin:0"><div style="height:2000px;background:rgb(255,0,0)"></div><div style="height:2000px;background:rgb(0,128,0)"></div></body>`;
    // Shown where it can be without taking the screen: a window never shown draws no frame under xvfb, and a capture waits seconds for one.
    const { windows, launch } = appWith(`app.whenReady().then(() => new BrowserWindow({ show: ${SHOWN}, width: 400, height: 300 }).loadURL('data:text/html,${page}'));`, ['--force-device-scale-factor=2']);
    await launch();
    const window = windows.require();
    expect(await window.page.evaluate(() => devicePixelRatio)).toBe(2);
    await window.page.evaluate(() => scrollTo(0, 2500));
    const raw = await readWindow(new DevTools(), window);
    const { pixels } = await withPixels(new DevTools(), raw, { root: { ref: { id: 'window', revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } });
    const size = await window.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(pixels).toMatchObject({ width: size.width, height: size.height, scale: 1 });
    const rgba = new Transformer(pixels!.data).rawPixelsSync();
    const channels = rgba.length / (size.width * size.height);
    const middle = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * channels;
    // Scrolled into the green half: the document's top, which a clip that ignored the scroll would show, is red.
    expect([rgba[middle], rgba[middle + 1], rgba[middle + 2]]).toEqual([0, 128, 0]);
  });

  it('captures a window the app showed and then hid, and one it opens and hides later', async () => {
    const { app, windows, launch } = appWith(`const page = (colour) => 'data:text/html,<body style="margin:0;background:' + colour + '"></body>';
      const open = async (url) => { const window = new BrowserWindow({ show: ${SHOWN}, width: 400, height: 300 }); await window.loadURL(url); await new Promise((resolve) => setTimeout(resolve, ${SHOWN_MS})); window.hide(); };
      app.whenReady().then(() => open(page('rgb(0,128,0)')));
      globalThis.openSecond = () => setTimeout(() => open(page('rgb(0,0,255)')));`);
    await launch();
    const hidden = (): Promise<boolean[]> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()), undefined);
    const corner = async (window: AppWindow): Promise<number[]> => {
      const raw = await readWindow(new DevTools(), window);
      const { pixels } = await withPixels(new DevTools(), raw, { root: { ref: { id: 'window', revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } });
      return [...new Transformer(pixels!.data).rawPixelsSync().subarray(0, 3)];
    };
    const first = windows.require();
    await expect.poll(hidden, { timeout: 10_000 }).toEqual([false]);
    expect(await corner(first)).toEqual([0, 128, 0]);
    await app.evaluate(() => void (globalThis as unknown as { openSecond: () => unknown }).openSecond(), undefined);
    await expect.poll(() => windows.open().length, { timeout: 10_000 }).toBe(2);
    await expect.poll(hidden, { timeout: 10_000 }).toEqual([false, false]);
    expect(await corner(windows.open().find((window) => window !== first)!)).toEqual([0, 0, 255]);
  });

  it('captures the whole page, one image pixel per CSS pixel, on a dense display, and says how far it is scrolled', async () => {
    const page = `<body style="margin:0;overflow-x:hidden"><div style="height:2000px;background:rgb(255,0,0)"></div><div style="height:2000px;background:rgb(0,128,0)"></div></body>`;
    const { windows, launch } = pageApp(page, { width: 400, height: 300, scale: 2 });
    await launch();
    const window = windows.require();
    await window.page.evaluate(() => scrollTo(0, 2500));
    const raw = await readWindow(new DevTools(), window);
    const { pixels } = await withPixels(new DevTools(), raw, { root: { ref: { id: 'window', revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } }, { fullPage: true });
    expect(pixels).toMatchObject({ height: 4000, scale: 1, scroll: { x: 0, y: 2500 } });
    const rgba = new Transformer(pixels!.data).rawPixelsSync();
    const channels = rgba.length / (pixels!.width * pixels!.height);
    const at = (y: number): number[] => [...rgba.subarray(y * pixels!.width * channels, y * pixels!.width * channels + 3)];
    expect(at(10)).toEqual([255, 0, 0]);
    expect(at(3990)).toEqual([0, 128, 0]);
    // The capture paints past the viewport without moving it.
    expect(await window.page.evaluate(() => scrollY)).toBe(2500);
  });

  /** How many red pixels a PNG holds, and the RGB at one point of it. */
  function inspect(png: Buffer): { readonly width: number; readonly height: number; readonly red: number; at(x: number, y: number): number[] } {
    const image = new Transformer(png);
    const { width, height } = image.metadataSync();
    const rgba = image.rawPixelsSync();
    const channels = rgba.length / (width * height);
    let red = 0;
    for (let offset = 0; offset < rgba.length; offset += channels) if (rgba[offset]! > 200 && rgba[offset + 1]! < 50) red += 1;
    return { width, height, red, at: (x, y) => [...rgba.subarray((y * width + x) * channels, (y * width + x) * channels + 3)] };
  }

  const PASSWORD = '<input type="password" value="hunter2" style="display:block;border:0;width:200px;height:40px;background:red">';

  it('masks a password field and a nested document below the viewport in a whole-page screenshot', async () => {
    const page = `<body style="margin:0;background:white"><div style="height:900px"></div>${PASSWORD}<div style="height:200px"></div>${RED_FRAME}<div style="height:200px"></div></body>`;
    // One image pixel per CSS pixel, so the field's place in the page is its place in the file.
    const { windows, launch, directory } = pageApp(page, { width: 300, height: 200, scale: 1 });
    await launch();
    const relative = await screenshotFile(new DevTools(), windows.require(), directory, 'page.png', () => undefined, { fullPage: true });
    const image = inspect(readFileSync(path.join(directory, relative)));
    expect(image.height).toBeGreaterThan(1300);
    expect(image.red).toBe(0);
    expect(image.at(100, 920)).toEqual([0, 0, 0]);
  });

  // The masks are fixed boxes measured at the current scroll: this holds only while the capture paints them where they show.
  it('masks fields above, below, and fixed to the bottom of a scrolled window in a whole-page screenshot', async () => {
    const fixed = '<input type="password" value="pinned" style="position:fixed;bottom:0;left:0;border:0;width:200px;height:30px;background:red">';
    const page = `<body style="margin:0;background:white"><div style="height:100px"></div>${PASSWORD}<div style="height:900px"></div>${PASSWORD}<div style="height:300px"></div>${fixed}</body>`;
    const { windows, launch, directory } = pageApp(page, { width: 300, height: 200, scale: 1 });
    await launch();
    const window = windows.require();
    await window.page.evaluate(() => scrollTo(0, 500));
    const relative = await screenshotFile(new DevTools(), window, directory, 'scrolled.png', () => undefined, { fullPage: true });
    const image = inspect(readFileSync(path.join(directory, relative)));
    expect(image.red).toBe(0);
    expect(image.at(100, 120)).toEqual([0, 0, 0]);
    expect(image.at(100, 1060)).toEqual([0, 0, 0]);
    expect(await window.page.evaluate(() => scrollY)).toBe(500);
  });

  it('captures the whole page and its clip at the window\'s zoom, and reads the pixels back at one per CSS pixel', async () => {
    const page = `<body style="margin:0;background:white"><div style="height:900px"></div>${PASSWORD}<div style="height:640px"></div></body>`;
    const { app, windows, launch, directory } = pageApp(page, { width: 300, height: 200, scale: 1 });
    await launch();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.5), undefined);
    const window = windows.require();
    await expect.poll(() => window.page.evaluate(() => devicePixelRatio)).toBe(1.5);
    const whole = inspect(readFileSync(path.join(directory, await screenshotFile(new DevTools(), window, directory, 'zoomed.png', () => undefined, { fullPage: true }))));
    // 200 CSS pixels wide and 1580 tall, at 1.5 image pixels each.
    expect([whole.width, whole.height, whole.red]).toEqual([300, 2370, 0]);
    const clipped = inspect(readFileSync(path.join(directory, await screenshotFile(new DevTools(), window, directory, 'zoomed-clip.png', () => undefined, { fullPage: true, clip: { x: 0, y: 900, width: 100, height: 40 } }))));
    expect([clipped.width, clipped.height, clipped.at(10, 10)]).toEqual([150, 60, [0, 0, 0]]);
    const raw = await readWindow(new DevTools(), window);
    const { pixels } = await withPixels(new DevTools(), raw, { root: { ref: { id: 'window', revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } }, { fullPage: true });
    expect(pixels).toMatchObject({ width: 200, height: 1580, scale: 1 });
  });

  it('refuses a whole-page capture past the pixels Electron paints in one screenshot, and takes a clip of it', async () => {
    const page = `<body style="margin:0;background:white"><div style="height:20000px"></div></body>`;
    const { windows, launch, directory } = pageApp(page, { width: 300, height: 200, scale: 1 });
    await launch();
    const window = windows.require();
    const refused = await screenshotFile(new DevTools(), window, directory, 'tall.png', () => undefined, { fullPage: true }).then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('past the 16384 pixels') });
    const clipped = inspect(readFileSync(path.join(directory, await screenshotFile(new DevTools(), window, directory, 'tall-clip.png', () => undefined, { fullPage: true, clip: { x: 0, y: 18000, width: 100, height: 100 } }))));
    expect([clipped.width, clipped.height]).toEqual([100, 100]);
  });

  it('cuts a whole-page screenshot to a clip in the page, and refuses one with nothing of the page inside it', async () => {
    const page = `<body style="margin:0;overflow-x:hidden"><div style="height:1000px;background:rgb(255,0,0)"></div><div style="height:1000px;background:rgb(0,128,0)"></div></body>`;
    const { windows, launch, directory } = pageApp(page, { width: 300, height: 200, scale: 1 });
    await launch();
    const window = windows.require();
    const relative = await screenshotFile(new DevTools(), window, directory, 'clip.png', () => undefined, { fullPage: true, clip: { x: 10, y: 1500, width: 50, height: 40 } });
    const image = new Transformer(readFileSync(path.join(directory, relative)));
    expect(image.metadataSync()).toMatchObject({ width: 50, height: 40 });
    const rgba = image.rawPixelsSync();
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([0, 128, 0]);
    const outside = await screenshotFile(new DevTools(), window, directory, 'far.png', () => undefined, { fullPage: true, clip: { x: 0, y: 5000, width: 10, height: 10 } }).then(() => undefined, (error: unknown) => error);
    expect(outside).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('is outside the') });
  });
});

describe('video', () => {
  const page = (title: string, colour: string): string => `'data:text/html,' + ${JSON.stringify(encodeURIComponent(`<title>${title}</title><body style="margin:0;background:${colour}">`))}`;
  const TWO_WINDOWS = `app.whenReady().then(async () => {
    await new BrowserWindow({ show: ${SHOWN}, width: 300, height: 200 }).loadURL(${page('One', 'rgb(255,0,0)')});
    await new BrowserWindow({ show: ${SHOWN}, width: 300, height: 200 }).loadURL(${page('Two', 'rgb(0,0,255)')});
  });`;

  /** Each frame of a video as one averaged colour. */
  function frameColours(ffmpeg: string, file: string): (readonly [number, number, number])[] {
    const { stdout, status } = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
    expect(status).toBe(0);
    const frames: (readonly [number, number, number])[] = [];
    for (let at = 0; at + 2 < stdout.length; at += 3) frames.push([stdout[at]!, stdout[at + 1]!, stdout[at + 2]!]);
    return frames;
  }

  async function twoWindows(): Promise<{ readonly windows: Windows; readonly directory: string; readonly ffmpeg: string }> {
    const { windows, launch, directory } = appWith(TWO_WINDOWS);
    await launch();
    await expect.poll(() => windows.open().length).toBe(2);
    return { windows, directory, ffmpeg: await ensureFfmpeg(process.env, new AbortController().signal) };
  }

  it('records the shown window, and the next one shown, into one file', async () => {
    const { windows, directory, ffmpeg } = await twoWindows();
    const [one, two] = windows.open();
    const recorder = new Recorder(ffmpeg, directory, 'video/video.webm', () => true);
    recorder.follow(one!.page);
    await new Promise((resolve) => setTimeout(resolve, 400));
    recorder.follow(two!.page);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const segments = await recorder.stop();
    expect(segments).toEqual([{ path: 'video/video.webm', startedAt: expect.any(String) as string }]);
    const frames = frameColours(ffmpeg, path.join(directory, 'video', 'video.webm'));
    expect(frames.length).toBeGreaterThan(20);
    const [red, , blue] = frames[0]!;
    expect(red).toBeGreaterThan(180);
    expect(blue).toBeLessThan(80);
    const last = frames.at(-1)!;
    expect(last[0]).toBeLessThan(80);
    expect(last[2]).toBeGreaterThan(180);
  });

  it('records a window the app hid', async () => {
    const { app, windows, launch, directory } = appWith(`const blinking = '<body style="margin:0;background:rgb(255,0,0)"><script>let blue = false; setInterval(() => { blue = !blue; document.body.style.background = blue ? "rgb(0,0,255)" : "rgb(255,0,0)"; }, 100)</script>';
      app.whenReady().then(() => new BrowserWindow({ show: ${SHOWN}, width: 300, height: 200 }).loadURL('data:text/html,' + encodeURIComponent(blinking)));`);
    await launch();
    const ffmpeg = await ensureFfmpeg(process.env, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, SHOWN_MS));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide(), undefined);
    const recorder = new Recorder(ffmpeg, directory, 'video/hidden.webm', () => true);
    recorder.follow(windows.require().page);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await recorder.stop()).toHaveLength(1);
    // The page turns blue and back while it is hidden: a recording of a window that stopped drawing would hold one colour.
    const frames = frameColours(ffmpeg, path.join(directory, 'video', 'hidden.webm'));
    expect(frames.some(([red, , blue]) => red > 180 && blue < 80)).toBe(true);
    expect(frames.some(([red, , blue]) => red < 80 && blue > 180)).toBe(true);
  });

  it('keeps no frame of a window it may not show, and writes no file for a recording with none', async () => {
    const { windows, directory, ffmpeg } = await twoWindows();
    const [one, two] = windows.open();
    const partial = new Recorder(ffmpeg, directory, 'video/partial.webm', (shown) => shown === one!.page);
    partial.follow(one!.page);
    await new Promise((resolve) => setTimeout(resolve, 300));
    partial.follow(two!.page);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await partial.stop()).toHaveLength(1);
    for (const [red, , blue] of frameColours(ffmpeg, path.join(directory, 'video', 'partial.webm'))) {
      expect(red).toBeGreaterThan(180);
      expect(blue).toBeLessThan(80);
    }
    const none = new Recorder(ffmpeg, directory, 'video/none.webm', () => false);
    none.follow(one!.page);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await none.stop()).toEqual([]);
    expect(existsSync(path.join(directory, 'video', 'none.webm'))).toBe(false);
  });
});
