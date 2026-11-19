/**
 * An attempt that adopts the tab a browser already shows, in the browser's
 * own user context (`adopt-tab`), on a scripted peer: the documents it
 * prepares as it adopts the tab, the tabs it closes when it ends, and what
 * it set in that user context and that tab, which it takes back.
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import type { BidiSession, SessionSettings } from '../../src/driver/session.ts';
import { adoptable, contextInfo, FakeBidi, navigationInfo, settle } from '../helpers/bidi-fake.ts';
import { closedTabs, unopened } from '../helpers/session-fake.ts';

/** One browsing context as `getTree` lists it under the adopted tab. */
interface Listed {
  readonly context: string;
  readonly url?: string;
  readonly children?: readonly Listed[];
}

/**
 * A peer whose browser shows the one tab `theirs`, with `frames` in it. A
 * tree read of the whole browser lists the tab alone, one rooted at the tab
 * lists its frames too, and every context has a script context of its own.
 */
function showing(frames: readonly Listed[] = []): FakeBidi {
  const tab = { context: 'theirs', userContext: 'default', url: 'http://app.test/' };
  return adoptable(new FakeBidi(), 'theirs')
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('browsingContext.getTree', (params) => ({ result: { contexts: [params['root'] === 'theirs' ? { ...tab, children: frames } : tab] } }))
    .on('script.getRealms', (params) => ({ result: { realms: [{ type: 'window', realm: 'r', origin: 'http://app.test', context: params['context'] }] } }));
}

/**
 * A session on `fake` that adopts the tab the browser shows, with no
 * viewport of its own, set up as `settings` say beside that, and told of the
 * browser's events as the running attempt is.
 */
function adopting(fake: FakeBidi, settings: Partial<SessionSettings> = {}): BidiSession {
  const tree = new ContextTree();
  tree.created('theirs', 'default', null);
  return unopened(fake, 'chromium', 'adopt-tab', { settings: { viewport: null, ...settings }, traits: BROWSER_TRAITS.chromium, exclusive: false, tree, routed: true });
}

/** The contexts the driver's own preloads were run in by hand (`prepareOpen`), each script in a `try` of its own. */
function prepared(fake: FakeBidi): string[] {
  return fake.commands('script.callFunction')
    .filter((command) => String(command.params['functionDeclaration']).startsWith('() => {\ntry {'))
    .map((command) => (command.params['target'] as { context: string }).context);
}

/**
 * Has the page of the adopted tab open three tabs on `fake`, which lists
 * every open tab from then on and drops one as it is closed: `joined`, whose
 * document loaded, `loading`, still waiting on its first, and `nowhere`,
 * whose only navigation got none.
 */
async function appOpensTabs(fake: FakeBidi): Promise<void> {
  const open = ['theirs'];
  fake
    .on('browsingContext.getTree', () => ({ result: { contexts: open.map((context) => ({ context, userContext: 'default', url: `http://app.test/${context}`, children: [] })) } }))
    .on('browsingContext.close', (params) => {
      open.splice(open.indexOf(String(params['context'])), 1);
      return { result: {} };
    });
  for (const popup of ['joined', 'loading', 'nowhere']) {
    open.push(popup);
    fake.emit('browsingContext.contextCreated', contextInfo(popup, { userContext: 'default', originalOpener: 'theirs' }));
    fake.emit('browsingContext.navigationStarted', navigationInfo(popup, `http://app.test/${popup}`));
  }
  fake.emit('browsingContext.domContentLoaded', navigationInfo('joined', 'http://app.test/joined'));
  fake.emit('browsingContext.navigationFailed', navigationInfo('nowhere', 'http://app.test/nowhere'));
  await settle();
}

describe('the tabs an attempt closes in a browser it adopted a tab of', () => {
  it('are, at its end, every tab the app opened, joined or not, and never the tab it adopted', async () => {
    const fake = showing();
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    await appOpensTabs(fake);
    expect(attached.tabs.list().map((tab) => tab.context)).toEqual(['theirs', 'joined']);
    await attached.close();
    expect(closedTabs(fake)).toEqual(['joined', 'loading', 'nowhere']);
  });

  it('are the same at a restart, which shows the adopted tab again', async () => {
    const fake = showing();
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    await appOpensTabs(fake);
    await attached.replaceTabs(new AbortController().signal);
    expect(closedTabs(fake)).toEqual(['joined', 'loading', 'nowhere']);
    expect(attached.tabs.list().map((tab) => tab.context)).toEqual(['theirs']);
  });
});

/** The parameters of each `method` command `fake` got, in order. */
function sent(fake: FakeBidi, method: string): Record<string, unknown>[] {
  return fake.commands(method).map((command) => command.params);
}

/** The CDP commands `fake` got that set or lift something, each with its parameters, in order. */
function cdpSent(fake: FakeBidi): unknown[] {
  return sent(fake, 'goog:cdp.sendCommand').filter((command) => !['Target.getTargets', 'Log.enable'].includes(String(command['method']))).map((command) => [command['method'], command['params']]);
}

const DEFAULT = { userContexts: ['default'] };

describe("what an attempt set in the browser's own user context", () => {
  it('is taken back when the attempt ends: each configured setting, the permissions it granted, and the viewport and focus of the tab it adopted', async () => {
    const fake = showing();
    const attached = adopting(fake, {
      viewport: { width: 500, height: 400 },
      userAgent: 'UA',
      locale: 'de-DE',
      timezoneId: 'Asia/Tokyo',
      media: { colorScheme: 'dark', reducedMotion: 'reduce' },
      permissions: ['clipboard-read'],
    });
    await attached.openUserContext(new AbortController().signal);
    await attached.userContext.visit('http://app.test/');
    await attached.close();

    expect(sent(fake, 'emulation.setUserAgentOverride')).toEqual([{ userAgent: 'UA', ...DEFAULT }, { userAgent: null, ...DEFAULT }]);
    expect(sent(fake, 'emulation.setLocaleOverride')).toEqual([{ locale: 'de-DE', ...DEFAULT }, { locale: null, ...DEFAULT }]);
    expect(sent(fake, 'network.setExtraHeaders')).toEqual([{ headers: [{ name: 'accept-language', value: { type: 'string', value: 'de-DE' } }], ...DEFAULT }, { headers: [], ...DEFAULT }]);
    expect(sent(fake, 'emulation.setTimezoneOverride')).toEqual([{ timezone: 'Asia/Tokyo', ...DEFAULT }, { timezone: null, ...DEFAULT }]);
    expect(sent(fake, 'emulation.setMediaFeaturesOverride')).toEqual([
      { features: { 'prefers-color-scheme': 'dark', 'prefers-reduced-motion': 'reduce' }, ...DEFAULT },
      { features: null, ...DEFAULT },
    ]);
    expect(sent(fake, 'browser.setDownloadBehavior').map((params) => params['downloadBehavior'])).toEqual([expect.objectContaining({ type: 'allowed' }), null]);
    expect(sent(fake, 'permissions.setPermission')).toEqual([{ descriptor: { name: 'clipboard-read' }, state: 'granted', origin: 'http://app.test', userContext: 'default' }]);
    expect(sent(fake, 'browsingContext.setViewport')).toEqual([
      { context: 'theirs', viewport: { width: 500, height: 400 }, devicePixelRatio: 1 },
      { context: 'theirs', viewport: null, devicePixelRatio: null },
    ]);
    expect(cdpSent(fake)).toEqual(expect.arrayContaining([
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Emulation.setFocusEmulationEnabled', { enabled: false }],
      ['Browser.resetPermissions', {}],
    ]));
    expect(cdpSent(fake)).toHaveLength(3);
  });

  it('is taken back when a test set it: the media it emulated, and the viewport it gave a tab that had none', async () => {
    const fake = showing();
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    await attached.userContext.emulateMedia({ colorScheme: 'dark' });
    await attached.userContext.emulateMedia({ colorScheme: 'light' });
    await attached.setViewport({ width: 320, height: 480 });
    await attached.close();
    expect(sent(fake, 'emulation.setMediaFeaturesOverride').map((params) => params['features'])).toEqual([{ 'prefers-color-scheme': 'dark' }, { 'prefers-color-scheme': 'light' }, null]);
    expect(sent(fake, 'browsingContext.setViewport').map((params) => params['viewport'])).toEqual([{ width: 320, height: 480 }, null]);
  });

  it('is all the attempt takes back: nothing it did not set, and no tab it opened itself', async () => {
    const fake = showing().on('browsingContext.create', { result: { context: 'mine' } });
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    await attached.newTab();
    await attached.setViewport({ width: 320, height: 480 });
    await attached.close();
    for (const unset of ['emulation.setUserAgentOverride', 'emulation.setLocaleOverride', 'network.setExtraHeaders', 'emulation.setTimezoneOverride', 'emulation.setMediaFeaturesOverride']) expect(sent(fake, unset)).toEqual([]);
    expect(sent(fake, 'browsingContext.setViewport')).toEqual([{ context: 'mine', viewport: { width: 320, height: 480 }, devicePixelRatio: 1 }]);
    expect(cdpSent(fake)).toEqual([
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Emulation.setFocusEmulationEnabled', { enabled: false }],
    ]);
  });

  it('is taken back, every other thing of it, when one cannot be, and the close fails with why', async () => {
    const fake = showing().on('emulation.setTimezoneOverride', (params) => (params['timezone'] === null ? { error: 'unknown error', message: 'no reset' } : { result: {} }));
    const attached = adopting(fake, { userAgent: 'UA', timezoneId: 'Asia/Tokyo', media: { colorScheme: 'dark' } });
    await attached.openUserContext(new AbortController().signal);
    await expect(attached.close()).rejects.toThrow('no reset');
    expect(sent(fake, 'emulation.setUserAgentOverride').at(-1)).toEqual({ userAgent: null, ...DEFAULT });
    expect(sent(fake, 'emulation.setMediaFeaturesOverride').at(-1)).toEqual({ features: null, ...DEFAULT });
  });

  it('is taken back by a setup that failed part way', async () => {
    const fake = showing().on('emulation.setLocaleOverride', (params) => (params['locale'] === null ? { result: {} } : { error: 'invalid argument', message: 'no such locale' }));
    const attached = adopting(fake, { userAgent: 'UA', locale: 'xx' });
    await expect(attached.openUserContext(new AbortController().signal)).rejects.toThrow('no such locale');
    expect(sent(fake, 'emulation.setUserAgentOverride')).toEqual([{ userAgent: 'UA', ...DEFAULT }, { userAgent: null, ...DEFAULT }]);
    expect(sent(fake, 'emulation.setLocaleOverride').at(-1)).toEqual({ locale: null, ...DEFAULT });
  });

  it('is left for the removal of a user context of the attempt\'s own, which takes it all', async () => {
    const fake = showing().on('browser.createUserContext', { result: { userContext: 'mine' } }).on('browsingContext.create', { result: { context: 'tab' } });
    const own = adopting(fake, { userContext: 'fresh', viewport: { width: 500, height: 400 }, userAgent: 'UA', media: { colorScheme: 'dark' } });
    await own.openUserContext(new AbortController().signal);
    await own.ensureContext();
    await own.close();
    expect(sent(fake, 'browser.removeUserContext')).toEqual([{ userContext: 'mine' }]);
    expect(sent(fake, 'emulation.setUserAgentOverride')).toEqual([{ userAgent: 'UA', userContexts: ['mine'] }]);
    expect(sent(fake, 'emulation.setMediaFeaturesOverride')).toHaveLength(1);
    expect(sent(fake, 'browser.setDownloadBehavior')).toHaveLength(1);
    expect(sent(fake, 'browsingContext.setViewport')).toHaveLength(1);
  });
});

describe('adopting the tab a browser shows', () => {
  it('grants the configured permissions to the origin of each document it shows, once an origin, and lifts them when the attempt ends', async () => {
    const fake = showing([
      { context: 'same', url: 'http://app.test/frame' },
      { context: 'other', url: 'https://pay.test/checkout', children: [{ context: 'nested', url: 'https://pay.test/3ds' }] },
      { context: 'inline', url: 'about:srcdoc' },
    ]);
    const attached = adopting(fake, { permissions: ['clipboard-read', 'geolocation'] });
    await attached.openUserContext(new AbortController().signal);
    const granted = sent(fake, 'permissions.setPermission');
    expect(granted.map((params) => [params['origin'], (params['descriptor'] as { name: string }).name])).toEqual([
      ['http://app.test', 'clipboard-read'],
      ['http://app.test', 'geolocation'],
      ['https://pay.test', 'clipboard-read'],
      ['https://pay.test', 'geolocation'],
    ]);
    expect(granted.every((params) => params['state'] === 'granted' && params['userContext'] === 'default')).toBe(true);
    expect(cdpSent(fake)).not.toContainEqual(['Browser.resetPermissions', {}]);
    await attached.close();
    expect(cdpSent(fake)).toContainEqual(['Browser.resetPermissions', {}]);
  });

  it('grants nothing when the target grants none', async () => {
    const fake = showing([{ context: 'frame', url: 'https://pay.test/checkout' }]);
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    await attached.close();
    expect(sent(fake, 'permissions.setPermission')).toEqual([]);
    expect(cdpSent(fake)).not.toContainEqual(['Browser.resetPermissions', {}]);
  });

  it('runs the driver\'s preloads in the tab and each frame it shows', async () => {
    const fake = showing([{ context: 'frame', children: [{ context: 'nested' }] }]);
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    expect(attached.context).toBe('theirs');
    expect(prepared(fake)).toEqual(['theirs', 'frame', 'nested']);
  });

  it('adopts a tab whose frame went away while its documents were listed, and prepares the documents left', async () => {
    const fake = showing([{ context: 'removed' }, { context: 'frame' }]);
    fake.on('script.getRealms', (params) => (params['context'] === 'removed'
      ? { error: 'no such frame', message: 'Context removed not found' }
      : { result: { realms: [{ type: 'window', realm: 'r', origin: 'http://app.test', context: params['context'] }] } }));
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    expect(attached.context).toBe('theirs');
    expect(fake.commands('script.getRealms').map((command) => command.params['context'])).toEqual(['theirs', 'removed', 'frame']);
    expect(prepared(fake)).toEqual(['theirs', 'frame']);
  });
});
