/**
 * A model provider that writes the caller's key back into its error text
 * (a proxy, a self-hosted gateway, a provider that quotes the bad
 * credential) must not put that key into anything the run writes. Through
 * the built CLI and the built-in agent, with the key only in the runner's
 * environment, the way a user sets `OPENAI_API_KEY`: the terminal, the
 * report, the summary, and each trace page hold the key's marker and no
 * piece of the key.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processSecrets } from '@e2e-dev/core/lib/run/secrecy';
import { contentsUnder, createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
/** The run of 8 characters the redactor treats as a fragment of a value. */
const FRAGMENT = 8;

/** A loopback provider answering every model call with `status` and an error message that quotes the bearer token it was sent. */
async function echoingProvider(status: number): Promise<{ server: Server; url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      seen.push(token);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${token}`, type: 'invalid_request_error', code: 'invalid_api_key' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return { server, url: `http://127.0.0.1:${address.port}/v1`, seen };
}

function config(providerUrl: string): string {
  return `import type { E2EConfig } from 'e2e';
import { createOpenAI } from '@ai-sdk/openai';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',
  agents: { default: { model: createOpenAI({ baseURL: ${JSON.stringify(providerUrl)} })('gpt-echo') } },
} satisfies E2EConfig;
`;
}

const SUITE = `import { test } from 'e2e';
test('asks the agent', async ({ app, agent }) => {
  await app.open();
  await agent.act('Open the menu.');
});
`;

/** Every piece of `key`'s random part at least `FRAGMENT` long that `text` holds, plainly or URL-encoded. */
function piecesOf(key: string, random: string, text: string): string[] {
  const start = key.length - random.length;
  const found: string[] = [];
  for (let at = start; at + FRAGMENT <= key.length; at += 1) {
    const piece = key.slice(at, at + FRAGMENT);
    if (text.includes(piece) || text.includes(encodeURIComponent(piece))) found.push(piece);
  }
  return found;
}

describe.each([400, 401])('a provider that echoes the key in an HTTP %i error', (status) => {
  const random = randomBytes(16).toString('hex');
  const key = `sk-echo-${random}`;
  let provider: Awaited<ReturnType<typeof echoingProvider>>;
  let project: FixtureProject;
  let output = '';
  let files: [string, string][] = [];

  beforeAll(async () => {
    provider = await echoingProvider(status);
    project = createProject({ 'e2e.config.ts': config(provider.url), 'tests/echo.e2e.ts': SUITE });
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '', NO_COLOR: '1', E2E_TELEMETRY_DISABLED: '1', OPENAI_API_KEY: key };
    for (const name of ['CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENROUTER_API_KEY', 'NODE_DEBUG']) delete env[name];
    try {
      const result = await execFileAsync(process.execPath, [CLI, 'run', '--reporter', 'list,markdown'], { cwd: project.dir, env, timeout: 90_000 });
      output = result.stdout + result.stderr;
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      output = (failed.stdout ?? '') + (failed.stderr ?? '');
    }
    files = contentsUnder(path.join(project.dir, '.e2e'));
  }, 120_000);

  afterAll(() => {
    provider?.server.close();
    project?.cleanup();
  });

  it('sent the key to the provider and failed the step on its answer', () => {
    expect(provider.seen).toContain(key);
    const report = JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')) as {
      run: { results: { attempts: { error?: { code?: string; message?: string } }[] }[] };
    };
    const error = report.run.results[0]?.attempts[0]?.error;
    expect(error?.code).toBe('MODEL_PROVIDER_FAILED');
    expect(error?.message).toContain('Incorrect API key provided: <secret:OPENAI_API_KEY>');
  });

  it('prints no piece of the key to the terminal', () => {
    expect(output).toContain('Incorrect API key provided');
    expect(piecesOf(key, random, output)).toEqual([]);
  });

  it('writes no piece of the key to the report, the summary, or a trace page', () => {
    const written = files.map(([file]) => path.relative(project.dir, file));
    expect(written).toEqual(expect.arrayContaining([path.join('.e2e', 'report.json'), path.join('.e2e', 'summary.md')]));
    expect(written.some((file) => file.endsWith('trace.md'))).toBe(true);
    const leaks = files.filter(([, text]) => piecesOf(key, random, text).length > 0).map(([file]) => path.relative(project.dir, file));
    expect(leaks).toEqual([]);
  });
});

/** Configs that load a key from `.env` and then fail in a way that quotes it: a plain error, an e2e error, and a value the config check quotes. */
const FAILING_CONFIGS = {
  'a plain error': "process.loadEnvFile('.env');\nthrow new Error('config failed with ' + process.env.GROQ_API_KEY);\n",
  'an e2e error': "import { ConfigurationError } from 'e2e/engine';\nprocess.loadEnvFile('.env');\nthrow new ConfigurationError('INVALID_CONFIG', 'config failed with ' + process.env.GROQ_API_KEY);\n",
  'a value the config check quotes': "process.loadEnvFile('.env');\nexport default { targets: [process.env.GROQ_API_KEY] };\n",
};

describe.each(Object.entries(FAILING_CONFIGS))('a config that loads a key from .env and then fails with %s', (_failure, configSource) => {
  const random = randomBytes(16).toString('hex');
  const key = `gsk-dotenv-${random}`;
  let project: FixtureProject;

  beforeAll(() => {
    project = createProject({ '.env': `GROQ_API_KEY=${key}\n`, 'e2e.config.ts': configSource });
  });

  afterAll(() => {
    project?.cleanup();
  });

  /** One command of the built CLI in the project, the key in no variable of its own: its exit code and output. */
  async function cli(...command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '', NO_COLOR: '1', E2E_TELEMETRY_DISABLED: '1' };
    for (const name of ['GROQ_API_KEY', 'NODE_DEBUG']) delete env[name];
    try {
      const result = await execFileAsync(process.execPath, [CLI, ...command], { cwd: project.dir, env, timeout: 60_000 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  }

  it.each(['run', 'list', 'doctor', 'cache stats'])('e2e %s names the key by its marker and prints no piece of it', async (command) => {
    const { code, stdout, stderr } = await cli(...command.split(' '));
    expect(code).toBe(2);
    expect(stdout + stderr).toContain('<secret:GROQ_API_KEY>');
    expect(piecesOf(key, random, stdout + stderr)).toEqual([]);
  }, 90_000);

  it('e2e doctor --json reports the failed config check with the marker in its message', async () => {
    const { code, stdout, stderr } = await cli('doctor', '--json');
    expect(code).toBe(2);
    const report = JSON.parse(stdout) as { schemaVersion: string; checks: { id: string; status: string; message?: string }[] };
    expect(report.schemaVersion).toBe('doctor-1');
    const check = report.checks.find((entry) => entry.id === 'config');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('<secret:GROQ_API_KEY>');
    expect(piecesOf(key, random, stdout + stderr)).toEqual([]);
  }, 90_000);
});

describe('a key only the environment handed to a run or a host holds', () => {
  const projects: FixtureProject[] = [];
  afterAll(() => {
    for (const project of projects) project.cleanup();
  });

  it('is redacted by the process that starts the run, before the config loads', async () => {
    const key = `sk-run-env-${randomBytes(12).toString('hex')}`;
    const project = createProject({ 'tests/none.e2e.ts': '' });
    projects.push(project);
    expect(processSecrets.redact(key)).toBe(key);
    await runExisting(project, { runOptions: { env: { OPENAI_API_KEY: key } } });
    expect(processSecrets.redact(`quoted ${key}`)).toBe('quoted <secret:OPENAI_API_KEY>');
  });

  it('is redacted by the process that opens a host, before the config loads', async () => {
    const key = `sk-host-env-${randomBytes(12).toString('hex')}`;
    const project = createProject({ 'tests/none.e2e.ts': '' });
    projects.push(project);
    const built = '../../dist/run/open-session.js';
    const { openHost } = (await import(built)) as typeof import('../../src/run/open-session.ts');
    // No config in the directory: the host refuses to open, after it has read the environment.
    await expect(openHost({ cwd: project.dir, env: { ANTHROPIC_API_KEY: key } })).rejects.toThrow();
    expect(processSecrets.redact(key)).toBe('<secret:ANTHROPIC_API_KEY>');
  });

  it('is redacted in the error of a host whose config loads the key itself and then fails', async () => {
    const key = `sk-host-config-${randomBytes(12).toString('hex')}`;
    const project = createProject({ 'e2e.config.ts': `process.env.DEEPSEEK_API_KEY = ${JSON.stringify(key)};\nthrow new Error('config failed with ' + process.env.DEEPSEEK_API_KEY);\n` });
    projects.push(project);
    const built = '../../dist/run/open-session.js';
    const { openHost } = (await import(built)) as typeof import('../../src/run/open-session.ts');
    try {
      const error = await openHost({ cwd: project.dir }).then(() => undefined, (rejection: unknown) => rejection);
      expect(String((error as Error).message)).toContain('config failed with <secret:DEEPSEEK_API_KEY>');
      expect(String((error as Error).stack)).not.toContain(key);
    } finally {
      delete process.env['DEEPSEEK_API_KEY'];
    }
  });

  it('is redacted by the process that launches a core host, before the engine prepares', async () => {
    const key = `sk-launch-env-${randomBytes(12).toString('hex')}`;
    const { launch } = await import('@e2e-dev/core');
    const { createFakeEngine, FAKE_APP } = await import('../helpers/fake-engine.ts');
    expect(processSecrets.redact(key)).toBe(key);
    const host = await launch(createFakeEngine().engine, { app: FAKE_APP, env: { XAI_API_KEY: key }, handleSignals: false });
    try {
      expect(processSecrets.redact(key)).toBe('<secret:XAI_API_KEY>');
    } finally {
      await host.close();
    }
  });
});

