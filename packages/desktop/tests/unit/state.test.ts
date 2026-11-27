import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { EngineState } from '@e2e-dev/core/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { desktop } from '../../src/engine.ts';
import { AppState, type StateHost } from '../../src/state.ts';
import { cleanUp, initialized, launched, operation, scratch } from '../helpers/surface.ts';

afterEach(cleanUp);

const signal = new AbortController().signal;
const ID = 'dev.e2e.scratch.state';
const EMPTY = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict/>\n</plist>\n';
const SAVED = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>count</key><integer>3</integer></dict></plist>\n';

/** A scripted machine: a temporary home, a defaults store in memory, and the copies of each bundle id macOS would list. */
class FakeHost implements StateHost {
  readonly home = scratch('home-');
  readonly defaults = new Map<string, string>();
  readonly calls: string[] = [];
  paths: string[] = [];
  running: { pid: number; path?: string }[] = [];

  async copies(bundleId: string) {
    this.calls.push(`copies ${bundleId}`);
    return { paths: this.paths, running: this.running };
  }
  async exportDefaults(bundleId: string) {
    this.calls.push(`export ${bundleId}`);
    return this.defaults.get(bundleId) ?? EMPTY;
  }
  async importDefaults(bundleId: string, plist: string) {
    this.calls.push(`import ${bundleId}`);
    this.defaults.set(bundleId, plist);
  }
  async deleteDefaults(bundleId: string) {
    this.calls.push(`delete ${bundleId}`);
    this.defaults.delete(bundleId);
  }

  /** Writes what the app keeps under the home: the directories a reset removes, and some it must leave. */
  plant(): Record<'savedState' | 'container' | 'support' | 'otherApp', string> {
    const library = path.join(this.home, 'Library');
    const planted = {
      savedState: path.join(library, 'Saved Application State', `${ID}.savedState`),
      container: path.join(library, 'Containers', ID),
      support: path.join(library, 'Application Support', 'Scratch'),
      otherApp: path.join(library, 'Saved Application State', 'com.example.other.savedState'),
    };
    for (const directory of Object.values(planted)) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'data'), 'x');
    }
    return planted;
  }
}

/** A built `.app` bundle declaring `ID`, in a new directory. */
function build(name = 'Scratch'): string {
  const bundle = path.join(scratch('build-'), `${name}.app`);
  mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
  writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${ID}</string></dict></plist>`);
  return bundle;
}

describe('AppState', () => {
  it('clears the defaults domain, the saved application state, and the container, and leaves the rest', async () => {
    const host = new FakeHost();
    host.defaults.set(ID, SAVED);
    host.defaults.set('com.example.other', SAVED);
    const planted = host.plant();
    await new AppState(host).reset(ID, signal);
    expect(host.defaults.has(ID)).toBe(false);
    expect(existsSync(planted.savedState)).toBe(false);
    expect(existsSync(planted.container)).toBe(false);
    // Not keyed by the bundle id, or another app's: left as they are.
    expect(existsSync(planted.support)).toBe(true);
    expect(existsSync(planted.otherApp)).toBe(true);
    expect(host.defaults.has('com.example.other')).toBe(true);
  });

  it('saves the defaults, and restores them as a replacement, never a merge', async () => {
    const host = new FakeHost();
    const state = new AppState(host);
    host.defaults.set(ID, SAVED);
    const saved = await state.capture(ID, signal);
    expect(saved).toEqual({ format: 'macos-app-state', version: 1, data: { bundleId: ID, defaults: SAVED } });
    host.defaults.set(ID, '<plist><dict><key>later</key><true/></dict></plist>');
    const planted = host.plant();
    await state.restore(ID, saved, signal);
    expect(host.defaults.get(ID)).toBe(SAVED);
    expect(host.calls.slice(-2)).toEqual([`delete ${ID}`, `import ${ID}`]);
    expect(existsSync(planted.savedState)).toBe(false);
    // An empty dictionary nested beside a value is part of the session, not an empty one.
    const nested = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>options</key><dict/><key>onboarded</key><true/></dict></plist>\n';
    await state.restore(ID, { format: 'macos-app-state', version: 1, data: { bundleId: ID, defaults: nested } }, signal);
    expect(host.defaults.get(ID)).toBe(nested);
    // A session with nothing in it leaves the domain empty, as the reset did.
    await state.restore(ID, { format: 'macos-app-state', version: 1, data: { bundleId: ID, defaults: EMPTY } }, signal);
    expect(host.defaults.has(ID)).toBe(false);
  });

  it("refuses a session another engine, version, or app wrote, before it touches the app's state", async () => {
    const host = new FakeHost();
    host.defaults.set(ID, SAVED);
    const state = new AppState(host);
    const sessions: EngineState[] = [
      { format: 'macos-defaults', version: 1, data: SAVED },
      { format: 'macos-app-state', version: 2, data: { bundleId: ID, defaults: SAVED } },
      { format: 'macos-app-state', version: 1, data: { bundleId: 'com.example.other', defaults: SAVED } },
    ];
    for (const session of sessions) await expect(state.restore(ID, session, signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(host.defaults.get(ID)).toBe(SAVED);
    expect(host.calls).toEqual([]);
  });

  it('refuses while macOS knows another copy of the bundle id, naming it, and passes the build itself', async () => {
    const host = new FakeHost();
    const state = new AppState(host);
    const own = build();
    const installed = build('Installed');
    const link = path.join(scratch('link-'), 'Linked.app');
    symlinkSync(own, link);
    // The build itself, by another path, and a registration whose bundle is gone are no other copy.
    host.paths = [own, link, path.join(scratch('gone-'), 'Gone.app')];
    await expect(state.requireSole({ path: own, bundleId: ID }, 'app.clearState()', signal)).resolves.toBeUndefined();
    host.paths = [own, installed];
    await expect(state.requireSole({ path: own, bundleId: ID }, 'app.clearState()', signal)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringMatching(new RegExp(`app\\.clearState\\(\\): the saved state of "${ID.replaceAll('.', '\\.')}".*another copy at .*Installed\\.app.*Nothing was changed`)),
    });
  });

  it("refuses while another process runs the app, the build's own path included, but not the engine's", async () => {
    const host = new FakeHost();
    const state = new AppState(host);
    const own = build();
    host.running = [{ pid: 4242, path: own }];
    await expect(state.requireSole({ path: own, bundleId: ID }, 'saving a session', signal, 4242)).resolves.toBeUndefined();
    await expect(state.requireSole({ path: own, bundleId: ID }, 'saving a session', signal, 1)).rejects.toMatchObject({ message: expect.stringContaining('running as process 4242') });
  });

  it('refuses a bundle id that cannot be looked up safely, asking nothing', async () => {
    const host = new FakeHost();
    for (const bundleId of ["dev.e2e.x' || true", '..', '.', 'dev..e2e', '.dev.e2e', 'dev.e2e.']) {
      await expect(new AppState(host).requireSole({ path: build(), bundleId }, 'app.clearState()', signal), bundleId).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    }
    expect(host.calls).toEqual([]);
  });

  it('never clears the global defaults domain, and takes an underscore in a bundle id', async () => {
    const host = new FakeHost();
    // The names `defaults delete` reads as the user's global preferences.
    for (const bundleId of ['-g', '-globalDomain', 'NSGlobalDomain', '-g.e2e']) {
      await expect(new AppState(host).requireSole({ path: build(), bundleId }, 'app.clearState()', signal), bundleId).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
      await expect(new AppState(host).reset(bundleId, signal), bundleId).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    }
    expect(host.calls).toEqual([]);
    const own = build();
    host.paths = [own];
    await expect(new AppState(host).requireSole({ path: own, bundleId: 'com.example.my_app' }, 'app.clearState()', signal)).resolves.toBeUndefined();
    expect(host.calls).toEqual(['copies com.example.my_app']);
  });

  it("never removes a directory above the app's own when the bundle id names a parent", async () => {
    const host = new FakeHost();
    const planted = host.plant();
    await expect(new AppState(host).reset('..', signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(host.calls).toEqual([]);
    for (const directory of Object.values(planted)) expect(existsSync(directory), directory).toBe(true);
  });
});

describe('the desktop state commands', () => {
  it('are declared: app.clearState() and test.setup sessions reach the engine', () => {
    const engine = desktop();
    expect(engine.session?.reset).toBeTypeOf('function');
    expect(engine.state?.capture).toBeTypeOf('function');
    expect(engine.state?.restore).toBeTypeOf('function');
  });

  it('refuses an installed app (a bundleId target) before asking macOS anything', async () => {
    const host = new FakeHost();
    host.defaults.set('dev.e2e.spike.form', SAVED);
    const { surface, fake } = await launched({}, { stateHost: host });
    const installed = { code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('only for an app.appPath target, a build the project makes. "dev.e2e.spike.form" is an installed app') };
    await expect(surface.reset(operation())).rejects.toMatchObject(installed);
    await expect(surface.captureState(operation())).rejects.toMatchObject(installed);
    await expect(surface.restoreState({ format: 'macos-app-state', version: 1, data: {} }, operation())).rejects.toMatchObject(installed);
    expect(host.calls).toEqual([]);
    expect(host.defaults.get('dev.e2e.spike.form')).toBe(SAVED);
    // The app was left running: nothing was quit for a refusal.
    expect(fake.of('launch')).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'darwin')('quits the build, clears its state, and launches it again', async () => {
    const host = new FakeHost();
    host.defaults.set(ID, SAVED);
    const planted = host.plant();
    const { surface, fake } = await launched({}, { stateHost: host, app: { appPath: build() } });
    const first = fake.pid;
    await surface.reset(operation());
    expect(host.defaults.has(ID)).toBe(false);
    expect(existsSync(planted.container)).toBe(false);
    expect(fake.of('launch')).toHaveLength(2);
    expect(fake.pid).not.toBe(first);
  });

  it.skipIf(process.platform !== 'darwin')('changes nothing, and leaves the app running, while another copy of the build exists', async () => {
    const host = new FakeHost();
    host.defaults.set(ID, SAVED);
    host.paths = [build('Installed')];
    const { surface, fake } = await launched({}, { stateHost: host, app: { appPath: build() } });
    await expect(surface.reset(operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('Nothing was changed') });
    expect(host.defaults.get(ID)).toBe(SAVED);
    expect(host.calls).toEqual([`copies ${ID}`]);
    expect(fake.of('launch')).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'darwin')('saves a session from the running build, and restores it before the app opens', async () => {
    const host = new FakeHost();
    host.defaults.set(ID, SAVED);
    const appPath = build();
    const { surface } = await launched({}, { stateHost: host, app: { appPath } });
    const saved = await surface.captureState(operation());
    host.defaults.set(ID, '<plist><dict><key>later</key><true/></dict></plist>');
    const { surface: next, fake } = await initialized({}, { stateHost: host, app: { appPath } });
    await next.restoreState(saved, operation());
    expect(host.defaults.get(ID)).toBe(SAVED);
    expect(fake.of('launch')).toHaveLength(0);
  });
});
