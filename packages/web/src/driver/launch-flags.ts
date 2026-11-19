/**
 * What each browser launches with on a fresh profile: Chromium's switches
 * and Firefox's preferences for an automated run, and the arguments that
 * put its endpoint on a free port.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WebMedia } from '../options.ts';

/**
 * The Chromium switches and disabled features an automated run launches
 * with, Playwright 1.64's set: no background throttling, no first-run UI,
 * nothing the browser fetches or shows on its own.
 */
const CHROMIUM_ARGS = [
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--disable-search-engine-choice-screen',
  '--disable-infobars',
  `--disable-features=${[
    'AvoidUnnecessaryBeforeUnloadCheckSync',
    'DestroyProfileOnBrowserClose',
    'DialMediaRouteProvider',
    'GlobalMediaControls',
    'HttpsUpgrades',
    'LensOverlay',
    'MediaRouter',
    'PaintHolding',
    'ThirdPartyStoragePartitioning',
    'BlockOriginHeaderModificationOnRedirect',
    'AvoidCorsURLLoaderRestartOnRedirect',
    'Translate',
    'AutoDeElevate',
    'OptimizationHints',
    'NetworkTimeServiceQuerying',
    'AimEnabled',
  ].join(',')}`,
  '--enable-features=CDPScreenshotNewSurface',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

/**
 * The Firefox preferences an automated profile takes, Playwright 1.64's BiDi
 * launcher's set (beside the Remote Agent's recommended set, which it applies on
 * start): nothing reaches the network on its own, the tab at the front of
 * the browser holds focus whatever window the system shows in front
 * (`focusmanager.testmode`; a tab behind it holds none, `BrowserTraits.focus`),
 * background windows keep full-rate timers, and startup opens no page of its
 * own. Beside
 * it, `layout.css.getBoxQuads.enabled` gives pages `getBoxQuads`, which the
 * driver maps a point through a frame a rotation or 3D transform turns with,
 * and no link hands its scheme (`mailto:`, an app's own) to the system, as
 * the Chromium headless shell never does: on a machine with no handler,
 * Firefox raises a dialog over the page that takes every later click.
 */
const FIREFOX_PREFS: Readonly<Record<string, string | number | boolean>> = {
  'app.normandy.api_url': '',
  'app.update.checkInstallTime': false,
  'app.update.disabledForTesting': true,
  'apz.content_response_timeout': 60_000,
  'ui.useOverlayScrollbars': 0,
  'network.protocol-handler.external-default': false,
  'network.protocol-handler.external.mailto': false,
  'browser.contentblocking.features.standard': '-tp,tpPrivate,cookieBehavior0,-cm,-fp',
  'browser.newtabpage.activity-stream.discoverystream.region-weather-config': '',
  'browser.newtabpage.activity-stream.newtabWallpapers.enabled': false,
  'browser.newtabpage.activity-stream.newtabWallpapers.v2.enabled': false,
  'browser.newtabpage.activity-stream.showSponsoredTopSites': false,
  'browser.newtabpage.activity-stream.feeds.system.topstories': false,
  'browser.newtabpage.enabled': false,
  'browser.pagethumbnails.capturing_disabled': true,
  'browser.safebrowsing.blockedURIs.enabled': false,
  'browser.safebrowsing.downloads.enabled': false,
  'browser.safebrowsing.malware.enabled': false,
  'browser.safebrowsing.phishing.enabled': false,
  'browser.search.update': false,
  'browser.sessionstore.resume_from_crash': false,
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage': 'about:blank',
  'browser.startup.homepage_override.mstone': 'ignore',
  'browser.startup.page': 0,
  'browser.tabs.disableBackgroundZombification': false,
  'browser.tabs.warnOnClose': false,
  'browser.tabs.warnOnCloseOtherTabs': false,
  'browser.tabs.warnOnOpen': false,
  'browser.translations.automaticallyPopup': false,
  'browser.uitour.enabled': false,
  'browser.urlbar.suggest.searches': false,
  'browser.warnOnQuit': false,
  'datareporting.healthreport.service.enabled': false,
  'datareporting.healthreport.uploadEnabled': false,
  'datareporting.usage.uploadEnabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'devtools.jsonview.enabled': false,
  'dom.disable_open_during_load': false,
  'dom.file.createInChild': true,
  'dom.ipc.reportProcessHangs': false,
  'dom.max_chrome_script_run_time': 0,
  'dom.max_script_run_time': 0,
  'dom.min_background_timeout_value': 0,
  'dom.min_background_timeout_value_without_budget_throttling': 0,
  'dom.timeout.enable_budget_timer_throttling': false,
  'dom.security.https_first': false,
  'extensions.autoDisableScopes': 0,
  'extensions.enabledScopes': 5,
  'extensions.getAddons.cache.enabled': false,
  'extensions.installDistroAddons': false,
  'extensions.update.enabled': false,
  'extensions.update.notifyUser': false,
  'focusmanager.testmode': true,
  'general.useragent.updates.enabled': false,
  'geo.provider.testing': true,
  'geo.wifi.scan': false,
  'hangmonitor.timeout': 0,
  'layout.css.getBoxQuads.enabled': true,
  'layout.testing.top-level-always-active': true,
  'media.gmp-manager.updateEnabled': false,
  'media.sanity-test.disabled': true,
  'network.connectivity-service.enabled': false,
  'network.cookie.sameSite.laxByDefault': false,
  'network.http.prompt-temp-redirect': false,
  'network.http.speculative-parallel-limit': 0,
  'network.manage-offline-status': false,
  'privacy.trackingprotection.enabled': false,
  'security.certerrors.mitm.priming.enabled': false,
  'security.fileuri.strict_origin_policy': false,
  'security.notification_enable_delay': 0,
  'signon.autofillForms': false,
  'signon.rememberSignons': false,
  'startup.homepage_welcome_url': 'about:blank',
  'startup.homepage_welcome_url.additional': '',
  'toolkit.cosmeticAnimations.enabled': false,
  'toolkit.startup.max_resumed_crashes': -1,
  // Wheel actions go through the path real wheels take, so a scroll shows on the next frame, as it does in Chromium.
  'remote.events.async.wheel.enabled': true,
  // Mouse actions too: the parent process routes them into an out-of-process (cross-site) frame, which a mouse
  // event synthesized in the top document's process never reaches.
  'remote.events.async.mouse.enabled': true,
  /**
   * A command whose document a navigation replaced under it fails (`no such
   * frame`), as it does on Chromium. By default Firefox sends it again to
   * the document that replaced it, up to 10 times, so a page function or a
   * key ran once more there. One sent to a first, empty document (a new
   * tab's, a frame's, the one a navigation to another site starts its
   * process with) is sent again whatever this says.
   */
  'remote.retry-on-abort': false,
  /**
   * No page is kept in the back-forward cache, as in Chromium
   * (`--disable-back-forward-cache`). A page kept there never answers a call
   * still running in it, so a read a navigation overtook, such as the wait
   * for a frame before a mouse or wheel action, would run to its timeout
   * instead of failing stale. `back` and `forward` load the page again.
   */
  'browser.sessionhistory.max_total_viewers': 0,
};

/** The arguments Chromium launches with on `profile`: the driver's switches, and its DevTools endpoint on a free port. */
export function chromiumArgs(profile: string, headed: boolean): string[] {
  return [
    ...CHROMIUM_ARGS,
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    ...(headed
      ? []
      : ['--headless', '--hide-scrollbars', '--mute-audio', '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4']),
    '--no-startup-window',
  ];
}

/**
 * Writes the driver's preferences into `profile`, and returns the arguments
 * Firefox launches with on it, its BiDi endpoint on a free port. The reduced
 * motion `media` asks for is one of the preferences, set for every page:
 * Firefox's BiDi media override leaves it out. The color scheme goes through
 * the override alone, so `emulateMedia({ colorScheme: 'no-preference' })`
 * clears it.
 */
export function firefoxArgs(profile: string, headed: boolean, media: WebMedia): string[] {
  const reducedMotion = media.reducedMotion;
  const prefs = { ...FIREFOX_PREFS, ...(reducedMotion === undefined ? {} : { 'ui.prefersReducedMotion': reducedMotion === 'reduce' ? 1 : 0 }) };
  const lines = Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
  writeFileSync(path.join(profile, 'user.js'), `${lines.join('\n')}\n`);
  return [
    '--remote-debugging-port=0',
    '--profile',
    profile,
    '-no-remote',
    ...(headed ? ['--foreground'] : ['--headless']),
    // On Windows firefox.exe hands off to the browser process and exits at once unless told to wait for it.
    ...(process.platform === 'win32' ? ['-wait-for-browser'] : []),
  ];
}
