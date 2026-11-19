/**
 * What `web(options)` and a target's `app` must satisfy, checked at config
 * load: a value the browser could not honor fails there, naming the option,
 * instead of at the first attempt.
 */

import {
  ConfigurationError,
  isSecret,
  rejectUnknownKeys,
  type AppPermissionState,
  type EngineAppCheckInfo,
  type EngineAppDeclaration,
} from '@e2e-dev/core/engine';
import { BROWSER_TRAITS, isBrowserName, type BrowserName } from './browsers.ts';
import { validateInitScripts } from './init-scripts.ts';
import { CONNECT_CONTEXTS, MEDIA_KEYS, mediaProblem, type ConnectContext, type WebConnectOptions, type WebOptions } from './options.ts';
import { FIELD_VALUE_CONTROL, headerProblem, originProblem } from './protected-app.ts';
import { asBrowserProvider, type BrowserProvider } from './provider.ts';

/** App fields only a device target reads. */
const NATIVE_APP_KEYS = ['bundleId', 'appPath', 'launchArguments'] as const;

/** What `checkWebOptions` reads from the options it checked. */
export interface CheckedWebOptions {
  readonly browser: BrowserName;
  readonly provider: BrowserProvider | undefined;
  /** `connect` with its `context` filled in (`'new'` when unset); undefined without `connect`. */
  readonly connect: Required<WebConnectOptions> | undefined;
}

/**
 * Checks every option of `web(options)` and names the browser they drive:
 * the provider that leases it when `browser` is one, else the built-in
 * browser by name, with the page a `connect` drives there.
 */
export function checkWebOptions(options: WebOptions): CheckedWebOptions {
  if ('allowedOrigins' in options) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'web({ allowedOrigins }) is gone: navigation and secret fills are not gated by origin; remove the option',
    );
  }
  if ('video' in options) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "web({ video }) was renamed web({ screencast }): it takes { size?, quality? } for the page screencast; which attempts record is the video mode on the config or a target",
    );
  }
  rejectUnknownKeys('web()', options, WEB_OPTION_KEYS);
  const provider = typeof options.browser === 'object' && options.browser !== null ? asBrowserProvider(options.browser) : undefined;
  if (provider !== undefined && options.connect !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ browser, connect }) names two browser sources; browser provider "${provider.name}" leases its own browsers, so remove connect`,
    );
  }
  const connect = options.connect === undefined ? undefined : validateConnect(options.connect);
  if (options.connect !== undefined && typeof options.browser === 'string' && !(isBrowserName(options.browser) && BROWSER_TRAITS[options.browser].cdp)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ connect }) requires the chromium browser; CDP attach is chromium-only, got "${options.browser}"`,
    );
  }
  if (options.headers !== undefined) validateHeaders(options.headers);
  if (options.basicAuth !== undefined) validateBasicAuth(options.basicAuth);
  if (options.credentialOrigins !== undefined) validateCredentialOrigins(options);
  if (options.testIdAttribute !== undefined) validateTestIdAttribute(options.testIdAttribute);
  if (options.userAgent !== undefined) validateUserAgent(options.userAgent, options.headers);
  if (options.locale !== undefined) validateLocale(options.locale, options.headers);
  if (options.timezoneId !== undefined) validateTimezoneId(options.timezoneId);
  validateMedia(options);
  if (options.initScripts !== undefined) validateInitScripts(options.initScripts);
  if (options.screencast !== undefined) validateScreencast(options.screencast);
  const browser: unknown = provider === undefined ? options.browser ?? 'chromium' : 'chromium';
  if (typeof browser !== 'string' || !isBrowserName(browser)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ browser }) drives chromium or firefox over WebDriver BiDi, got ${JSON.stringify(browser)}`);
  }
  return { browser, provider, connect };
}

/** Every option `web()` takes, kept equal to `WebOptions` by the compiler. */
const WEB_OPTION_KEYS: readonly string[] = Object.keys({
  browser: true,
  viewport: true,
  screencast: true,
  connect: true,
  headers: true,
  basicAuth: true,
  credentialOrigins: true,
  testIdAttribute: true,
  userAgent: true,
  locale: true,
  timezoneId: true,
  colorScheme: true,
  reducedMotion: true,
  initScripts: true,
} satisfies Record<keyof WebOptions, true>);

/**
 * An object literal (or `Object.create(null)`): not an array, a class
 * instance, or a primitive. Config runs as JavaScript, so the types alone are
 * no guard.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True for a whole number no less than `min`. */
function isIntegerFrom(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

/** Names a value's kind for a config error without echoing it: a CDP URL can carry a session token. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'object' ? 'an object' : `a ${type}`;
}

/**
 * `cdpEndpoint` is the resolver `connect` attaches through. Without it the
 * attach would call an undefined resolver, so a config missing it fails
 * here, at load, instead of at worker init with `ENGINE_FAILURE: ... resolve
 * is not a function`. `context` is one of `CONNECT_CONTEXTS`, `'new'` when
 * unset. Any other key, a removed `reconnectEndpoint` included, is refused.
 * Returns the two as checked.
 */
function validateConnect(connect: unknown): Required<WebConnectOptions> {
  if (!isPlainObject(connect)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ connect }) must be a plain object: { cdpEndpoint, context? }, got ${kindOf(connect)}`);
  }
  rejectUnknownKeys('web({ connect })', connect, ['cdpEndpoint', 'context'] satisfies (keyof WebConnectOptions)[]);
  const { cdpEndpoint, context = 'new' } = connect;
  if (cdpEndpoint === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ connect }) requires cdpEndpoint, the resolver that provisions the browser: (signal) => url');
  }
  if (typeof cdpEndpoint !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `web({ connect: { cdpEndpoint } }) must be a resolver function (signal) => url, got ${kindOf(cdpEndpoint)}`);
  }
  if (!CONNECT_CONTEXTS.some((known) => known === context)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ connect: { context } }) must be ${CONNECT_CONTEXTS.map((known) => JSON.stringify(known)).join(' or ')}, got ${typeof context === 'string' ? JSON.stringify(context) : kindOf(context)}`,
    );
  }
  return { cdpEndpoint: cdpEndpoint as WebConnectOptions['cdpEndpoint'], context: context as ConnectContext };
}

/**
 * Refuses a header the browser could not send, at config load rather than at
 * the first request: a name outside the token grammar, a value carrying a
 * control character (a line break is a header-injection vector), or a value
 * that is not a string at all.
 */
function validateHeaders(headers: unknown): void {
  if (!isPlainObject(headers)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ headers }) must be an object of header name to value');
  }
  for (const [name, value] of Object.entries(headers)) {
    const problem = headerProblem(name, value);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', `web({ headers }) ${problem}`);
  }
}

/**
 * Rejects a `credentialOrigins` that is not an array, names an entry that is
 * not an `http:` or `https:` origin, or comes without `headers` or
 * `basicAuth` to send, naming the entry.
 */
function validateCredentialOrigins({ credentialOrigins, headers, basicAuth }: WebOptions): void {
  if (headers === undefined && basicAuth === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ credentialOrigins }) requires headers or basicAuth: it lists more origins that receive them');
  }
  if (!Array.isArray(credentialOrigins)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ credentialOrigins }) must be an array of origins such as "https://preview.example.com"');
  }
  for (const [index, origin] of credentialOrigins.entries()) {
    const problem = originProblem(origin);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', `web({ credentialOrigins })[${index}] ${problem}`);
  }
}

/** Refuses credentials the browser could not present: a missing field, or a `:` in the user name (RFC 7617). */
function validateBasicAuth(basicAuth: unknown): void {
  if (!isPlainObject(basicAuth)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) must be an object with username and password');
  }
  rejectUnknownKeys('web({ basicAuth })', basicAuth, ['username', 'password']);
  const { username, password } = basicAuth;
  if (typeof username !== 'string' || username === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) requires a non-empty username string');
  }
  if (username.includes(':')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) username must not contain ":"');
  }
  if (typeof password !== 'string' && !isSecret(password)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) requires a password string or secrets.get(name)');
  }
}

/**
 * Refuses a user agent the browser could not send (not a string, empty, or
 * carrying a control character) and one a `user-agent` header would override
 * on the app's site while `navigator.userAgent` kept reporting it.
 */
function validateUserAgent(userAgent: unknown, headers: Readonly<Record<string, string>> | undefined): void {
  if (typeof userAgent !== 'string' || userAgent === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) must be a non-empty string');
  }
  if (FIELD_VALUE_CONTROL.test(userAgent)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) must not contain a control character');
  }
  if (headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) and a user-agent header in web({ headers }) conflict; set userAgent only');
  }
}

/**
 * Refuses a locale that is not a BCP 47 tag, and one an `accept-language`
 * header would override on the app's site while `navigator.language` kept
 * reporting it.
 */
function validateLocale(locale: unknown, headers: Readonly<Record<string, string>> | undefined): void {
  if (typeof locale !== 'string' || locale === '' || !isLanguageTag(locale)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ locale }) must be a BCP 47 language tag such as "de-DE", got ${JSON.stringify(locale)}`);
  }
  if (headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() === 'accept-language')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ locale }) and an accept-language header in web({ headers }) conflict; set locale only');
  }
}

/**
 * True when `tag` names a language the browser can run in: a Unicode locale
 * `Intl.Locale` parses, other than the undetermined `und`, which Chromium
 * refuses at context creation as it does a private-use-only tag.
 */
function isLanguageTag(tag: string): boolean {
  try {
    const { language } = new Intl.Locale(tag);
    return language !== undefined && language !== 'und';
  } catch {
    return false;
  }
}

/**
 * Refuses, at config load, a time zone the browser would otherwise refuse at
 * the first context. Best effort: Node cannot tell a miscased alias
 * (`us/eastern`) from the real one, so the browser's own `Invalid timezone ID`
 * stays the final word.
 */
function validateTimezoneId(timezoneId: unknown): void {
  if (typeof timezoneId !== 'string' || timezoneId === '' || !isTimeZone(timezoneId)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ timezoneId }) must be an IANA time zone such as "Europe/Berlin", got ${JSON.stringify(timezoneId)}`);
  }
}

/**
 * Refuses a media feature value the browser does not emulate, at config load
 * rather than at the first page.
 */
function validateMedia(options: WebOptions): void {
  for (const key of MEDIA_KEYS) {
    const problem = mediaProblem((name) => `web({ ${name} })`, key, options[key]);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', problem);
  }
}

/**
 * True when `timeZone` is an IANA name `Intl` resolves, spelled with its own
 * case. Node also takes an offset (`+01:00`) and any casing (`europe/berlin`),
 * both of which Chromium refuses; an alias resolving to another name
 * (`US/Eastern`) is fine.
 */
function isTimeZone(timeZone: string): boolean {
  if (/^[+-]/.test(timeZone)) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
    return resolved === timeZone || resolved.toLowerCase() !== timeZone.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * An attribute name the document grammar accepts (XML `Name`, ASCII): a value
 * outside it could never be on an element, so `getByTestId` would match nothing
 * and every `testId` query would fail silently.
 */
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

/** `web({ screencast })`: a whole-pixel frame size and a 0-100 JPEG quality, each optional. */
function validateScreencast(screencast: unknown): void {
  if (!isPlainObject(screencast)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast }) must be a plain object: { size?, quality? }');
  }
  for (const key of Object.keys(screencast)) {
    if (key !== 'size' && key !== 'quality') {
      throw new ConfigurationError('INVALID_CONFIG', `web({ screencast }) has unknown key "${key}"; it is { size?, quality? }, and which attempts record is the config's video`);
    }
  }
  const { size, quality } = screencast;
  if (size !== undefined) {
    const fields = isPlainObject(size) ? size : {};
    const unknownKey = Object.keys(fields).find((key) => key !== 'width' && key !== 'height');
    if (unknownKey !== undefined) {
      throw new ConfigurationError('INVALID_CONFIG', `web({ screencast: { size } }) has unknown key "${unknownKey}"; it is { width, height }`);
    }
    if (!isIntegerFrom(fields['width'], 1) || !isIntegerFrom(fields['height'], 1)) {
      throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast: { size } }) must be { width, height } in whole pixels, each at least 1');
    }
  }
  if (quality !== undefined && !(isIntegerFrom(quality, 0) && quality <= 100)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast: { quality } }) must be an integer from 0 through 100');
  }
}

/** Refuses a test-id attribute no element could carry, at config load. */
function validateTestIdAttribute(attribute: unknown): void {
  if (typeof attribute !== 'string' || !ATTRIBUTE_NAME.test(attribute)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ testIdAttribute }) must be an attribute name such as "data-testid", got ${JSON.stringify(attribute)}`,
    );
  }
}

/**
 * A browser target opens a URL: without `app.url` there is nothing for
 * `app.open()` to open, and the fields that describe an installed device app
 * have nothing to act on here. `permissions` must be ones `browser` grants.
 */
export function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo, browser: BrowserName, urlRequired: boolean): void {
  for (const key of NATIVE_APP_KEYS) {
    if (app[key] !== undefined) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `target "${targetName}" declares app.${key}, which describes an installed device app; a web() target opens app.url`,
      );
    }
  }
  if (urlRequired && app.url === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `target "${targetName}" needs app.url: a web() target opens the app at a URL, targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }]`,
    );
  }
  if (app.permissions !== undefined) validatePermissions(targetName, browser, app.permissions);
}

/**
 * Refuses a permission `browser` cannot grant, and any state but `grant`:
 * the engine only grants, and Chromium denies every permission a grant
 * leaves out, so neither `deny` nor `reset` can mean what it does on a
 * device. The harness has checked the map's shape and states already.
 */
function validatePermissions(targetName: string, browser: BrowserName, permissions: Readonly<Record<string, AppPermissionState>>): void {
  const where = `target "${targetName}" app.permissions`;
  rejectUnknownKeys(`${where} on ${browser}`, permissions, BROWSER_TRAITS[browser].permissions);
  for (const [name, state] of Object.entries(permissions)) {
    if (state !== 'grant') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where}.${name} is ${state}, but a web() target only grants; leave the permission out instead`,
      );
    }
  }
}
