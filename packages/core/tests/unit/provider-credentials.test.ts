import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TargetSession } from '../../src/engine/surface.ts';
import { redactSecrets, registerProviderKey, registerProviderKeys } from '../../src/agent/public.ts';
import {
  carriedSecrets,
  processSecrets,
  redactsDownloads,
  registerStaticSecrets,
  releaseSessionLedger,
  sessionLedger,
  staticSecretLedger,
} from '../../src/run/secrecy.ts';

/** The variables model providers read their key from, whose values every ledger redacts. */
const PROVIDER_VARIABLES = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AI_GATEWAY_API_KEY',
  'LLM_API_KEY',
  'VERCEL_OIDC_TOKEN',
  'OPENROUTER_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'OPENCODE_API_KEY',
] as const;

const NO_SECRETS = new Map();
const opened: TargetSession[] = [];

/** A fake key no earlier test registered, so what one test shares cannot answer for another. */
function fakeKey(): string {
  return `sk-test-${randomBytes(12).toString('hex')}`;
}

function newSession(): TargetSession {
  const session = {} as unknown as TargetSession;
  opened.push(session);
  return session;
}

beforeEach(() => {
  // The developer's own keys must not decide a test.
  for (const name of PROVIDER_VARIABLES) vi.stubEnv(name, undefined);
});

afterEach(() => {
  for (const session of opened.splice(0)) releaseSessionLedger(session);
  vi.unstubAllEnvs();
});

describe('provider credentials in the environment', () => {
  it.each(PROVIDER_VARIABLES)('redacts %s from session and process text as its own marker', (name) => {
    const key = fakeKey();
    vi.stubEnv(name, key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(`provider said: bad key ${key}.`)).toBe(`provider said: bad key <secret:${name}>.`);
    expect(processSecrets.redact(`echo ${key}`)).toBe(`echo <secret:${name}>`);
  });

  it('redacts a key set in the environment before the run registers its secrets', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    registerStaticSecrets(NO_SECRETS);
    expect(processSecrets.redact(`rejected ${key}`)).toBe('rejected <secret:OPENAI_API_KEY>');
  });

  it('redacts the key as the provider uses it, without the spaces or line break around it', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', `  ${key}\n`);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(`Bearer ${key}"`)).toBe('Bearer <secret:OPENAI_API_KEY>"');
  });

  it('redacts the key in the spellings a report or URL gives it', () => {
    const key = `${fakeKey()}/+=`;
    vi.stubEnv('ANTHROPIC_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(`q=${encodeURIComponent(key)}`)).toBe('q=<secret:ANTHROPIC_API_KEY>');
    expect(ledger.redact(JSON.stringify({ message: key.toUpperCase() }))).toBe('{"message":"<secret:ANTHROPIC_API_KEY>"}');
  });

  it('redacts a key cut short at a length limit', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redactCut(`credential ${key.slice(0, 14)}`)).toBe('credential <secret:OPENAI_API_KEY>');
  });

  it.each(['ollama', 'lm-studio', 'sk-no-key-required', 'q7z9w3k1m5p8r2t6v0x'])('leaves the placeholder %s a local model server takes alone, so ordinary text is not rewritten', (placeholder) => {
    vi.stubEnv('OPENAI_API_KEY', placeholder);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(`Open the ${placeholder} settings`)).toBe(`Open the ${placeholder} settings`);
  });

  it('redacts a key of exactly 20 characters, the shortest it takes for one', () => {
    vi.stubEnv('OPENAI_API_KEY', 'q7z9w3k1m5p8r2t6v0xy');
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact('key q7z9w3k1m5p8r2t6v0xy.')).toBe('key <secret:OPENAI_API_KEY>.');
  });

  it('leaves an empty or blank variable alone', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '   ');
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact('text with   spaces')).toBe('text with   spaces');
  });

  it('reads only the provider variables it names, not every variable that looks like a key', () => {
    const value = fakeKey();
    vi.stubEnv('E2E_PROBE_UNRELATED_SETTING', value);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(value)).toBe(value);
  });

  it('redacts a key set after an earlier session opened, in sessions opened later', () => {
    sessionLedger(newSession(), NO_SECRETS);
    const key = fakeKey();
    vi.stubEnv('XAI_API_KEY', key);
    expect(sessionLedger(newSession(), NO_SECRETS).redact(key)).toBe('<secret:XAI_API_KEY>');
  });

  it('keeps redacting a key after the session that first saw it ends', () => {
    const key = fakeKey();
    vi.stubEnv('OPENROUTER_API_KEY', key);
    const first = newSession();
    sessionLedger(first, NO_SECRETS);
    releaseSessionLedger(first);
    expect(sessionLedger(newSession(), NO_SECRETS).redact(key)).toBe('<secret:OPENROUTER_API_KEY>');
    expect(processSecrets.redact(key)).toBe('<secret:OPENROUTER_API_KEY>');
  });
});

describe('provider credentials leave the rest of secrecy as it was', () => {
  it('does not turn on download rewriting', () => {
    vi.stubEnv('OPENAI_API_KEY', fakeKey());
    vi.stubEnv('ANTHROPIC_API_KEY', fakeKey());
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(process.env['OPENAI_API_KEY']!)).toBe('<secret:OPENAI_API_KEY>');
    expect(redactsDownloads(ledger)).toBe(false);
  });

  it('still rewrites downloads once the session holds a secret of the run', () => {
    vi.stubEnv('OPENAI_API_KEY', fakeKey());
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('token', 'run-secret-value-9931');
    expect(redactsDownloads(ledger)).toBe(true);
  });

  it('does not carry a key into a saved session', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('token', 'run-secret-value-4410');
    expect(carriedSecrets(ledger, NO_SECRETS)).toEqual([['token', 'run-secret-value-4410']]);
    expect(ledger.entries().some(([, value]) => value === key)).toBe(false);
  });

  it('lets a run secret that holds the key win the marker, so the run names it', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('apiKey', `${key}-suffix`);
    expect(ledger.redact(`${key}-suffix and ${key}`)).toBe('<secret:apiKey> and <secret:OPENAI_API_KEY>');
  });
});

describe('provider keys and the rest of redaction', () => {
  it('redacts a key from text redacted before any session, such as a test title', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = staticSecretLedger(new Map());
    expect(ledger.redact(`title ${key}`)).toBe('title <secret:OPENAI_API_KEY>');
    expect(ledger.entries()).toEqual([]);
  });

  it('leaves a key in a download as the app served it, even when the download is rewritten for a secret of the run', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('token', 'run-secret-value-7702');
    expect(ledger.redactAppFragments(`export run-secret-value-7702 ${key}`)).toBe(`export <secret:token> ${key}`);
  });

  it('matches a key whole, never in part: keys of one provider share a prefix', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-shared-prefix-aaaa1111bbbb2222');
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('token', 'run-secret-value-6613');
    const other = 'sk-proj-shared-prefix-cccc3333dddd4444';
    expect(ledger.redactFragments(`diff ${other} secret-value-66`)).toBe(`diff ${other} <secret:token>`);
    expect(ledger.redactFragments('sk-proj-shared-prefix-aaaa1111bbbb2222')).toBe('<secret:OPENAI_API_KEY>');
  });

  it('keeps a key that is also a secret of the run as that secret: named by the run, and rewritten in downloads', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('apiKey', key);
    expect(ledger.redact(key)).toBe('<secret:apiKey>');
    expect(redactsDownloads(ledger)).toBe(true);
    expect(ledger.redactAppFragments(key)).toBe('<secret:apiKey>');
  });
});

describe('what an executor registers and redacts', () => {
  it('redacts a key an executor registers, trimmed, under the name it gave', () => {
    const key = fakeKey();
    expect(redactSecrets(key)).toBe(key);
    registerProviderKey('agent.saved-key', ` ${key}\n`);
    expect(redactSecrets(`quoted ${key}`)).toBe('quoted <secret:agent.saved-key>');
    expect(sessionLedger(newSession(), NO_SECRETS).redact(key)).toBe('<secret:agent.saved-key>');
  });

  it('leaves a registered value shorter than 20 characters alone, and takes one of exactly 20', () => {
    registerProviderKey('agent.short', 'zq7k2w9d4h6j1n3b5c8');
    registerProviderKey('agent.shortest', 'zq7k2w9d4h6j1n3b5c8f');
    expect(redactSecrets('zq7k2w9d4h6j1n3b5c8, zq7k2w9d4h6j1n3b5c8f')).toBe('zq7k2w9d4h6j1n3b5c8, <secret:agent.shortest>');
  });

  it.each(['', 'has space', 'a>b', 'tab\tname', 'ünïcode'])('refuses the name %j, which a marker cannot spell', (name) => {
    expect(() => registerProviderKey(name, fakeKey())).toThrow(new TypeError(`registerProviderKey: the name ${JSON.stringify(name)} must be letters, digits, "_", ".", or "-"`));
  });

  it('takes a name of letters, digits, underscores, dots, and dashes', () => {
    const key = fakeKey();
    registerProviderKey('Agent_1.saved-key', key);
    expect(redactSecrets(key)).toBe('<secret:Agent_1.saved-key>');
  });

  it('registers the provider keys of an environment an agent starts with, and no other variable of it', () => {
    const key = fakeKey();
    const other = fakeKey();
    registerProviderKeys({ ANTHROPIC_API_KEY: key, PATH: other, OPENAI_API_KEY: undefined });
    expect(redactSecrets(`${key} ${other}`)).toBe(`<secret:ANTHROPIC_API_KEY> ${other}`);
  });

  it('redacts the secrets of the run too, for text an executor cuts before returning it', () => {
    registerStaticSecrets(new Map([['password', { name: 'password', purpose: 'password', value: 'run-secret-value-1187' }]]));
    expect(redactSecrets('typed run-secret-value-1187')).toBe('typed <secret:password>');
  });
});

describe('a verdict summary that is cut to its limit', () => {
  it('is redacted before the cut, so a key across the limit leaves no part of itself', async () => {
    const { validateVerdict } = await import('../../src/agent/act-validation.ts');
    const key = fakeKey();
    registerProviderKey('agent.key', key);
    // The key starts 10 characters before the 2000-character limit.
    const summary = `  ${'x'.repeat(1990)}${key} and more  `;
    const verdict = validateVerdict({ status: 'failed', summary }, 'probe', redactSecrets);
    expect(verdict.summary).toBe(`${'x'.repeat(1990)}<secret:ag`);
    expect(verdict.summary).not.toContain(key.slice(0, 10));
  });
});

describe('the ledger and what is beside it', () => {
  it('stands alone with nothing beside it', async () => {
    const { SecretLedger } = await import('../../src/internal/redact.ts');
    const ledger = new SecretLedger([['token', 'alone-secret-value-3391']]);
    expect(ledger.redact('alone-secret-value-3391')).toBe('<secret:token>');
    expect(ledger.redactsAppSecrets).toBe(true);
    expect(ledger.redactAppFragments('secret-value-33')).toBe('<secret:token>');
    expect(ledger.redact('plain text stays as written')).toBe('plain text stays as written');
    expect(new SecretLedger().redactsAppSecrets).toBe(false);
  });

  it('rewrites downloads from the moment a session beside it holds a secret, before it redacts anything else', () => {
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    // What the app-only view holds now; a secret another test file shared for good may be in it.
    expect(ledger.redactAppFragments('adjacent-ledger-token-8812')).toBe('adjacent-ledger-token-8812');
    sessionLedger(newSession(), new Map([['beside', { name: 'beside', purpose: 'generic-secret', value: 'adjacent-ledger-token-8812' }]]) as never);
    expect(redactsDownloads(ledger)).toBe(true);
    expect(ledger.redactAppFragments('adjacent-ledger-token-8812')).toBe('<secret:beside>');
  });

  it('keeps two secrets apart whose name and value run together to the same text', async () => {
    const { SecretLedger } = await import('../../src/internal/redact.ts');
    const ledger = new SecretLedger([
      ['tok', 'enA-shared-value-1'],
      ['toke', 'nA-shared-value-1'],
    ]);
    expect(ledger.redact('enA-shared-value-1')).toBe('<secret:tok>');
    expect(ledger.redactAppFragments('enA-shared-value-1')).toBe('<secret:tok>');
  });

  it('sees a key and a shared secret that arrive together after it last redacted', () => {
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    const key = fakeKey();
    expect(ledger.redact(key)).toBe(key);
    registerProviderKey('agent.late-key', key);
    sessionLedger(newSession(), new Map([['late', { name: 'late', purpose: 'generic-secret', value: 'late-shared-secret-5540' }]]) as never);
    expect(ledger.redact(`${key} late-shared-secret-5540`)).toBe('<secret:agent.late-key> <secret:late>');
  });

  it('sees a key registered after the static ledger last redacted', () => {
    const ledger = staticSecretLedger(new Map());
    const key = fakeKey();
    expect(ledger.redact(key)).toBe(key);
    registerProviderKey('agent.later-key', key);
    expect(ledger.redact(key)).toBe('<secret:agent.later-key>');
  });

  it('keeps the keys where another copy of the package in the process finds them', () => {
    registerProviderKey('agent.shared-slot', fakeKey());
    expect(Object.getOwnPropertySymbols(globalThis)).toContain(Symbol.for('e2e.providerKeys.v1'));
  });
});

describe('a process that has loaded no config yet', () => {
  it('redacts the keys of its environment, and its errors, from the moment the module loads', async () => {
    const key = fakeKey();
    vi.stubEnv('OPENROUTER_API_KEY', key);
    const errors = await import('../../src/internal/errors.ts');
    errors.setErrorRedactor(undefined);
    vi.resetModules();
    const fresh = await import('../../src/run/secrecy.ts');
    expect(fresh.processSecrets.redact(key)).toBe('<secret:OPENROUTER_API_KEY>');
    const serialized = errors.serializeError(new errors.ConfigurationError('INVALID_CONFIG', `config threw: ${key}`));
    expect(serialized.message).toBe('config threw: <secret:OPENROUTER_API_KEY>');
  });
});
