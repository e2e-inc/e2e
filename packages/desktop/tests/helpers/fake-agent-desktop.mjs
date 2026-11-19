#!/usr/bin/env node
// A scripted agent-desktop: answers each command with the next envelope the
// scenario lists for it (the last one repeats), and logs every call with the
// stdin it received. Scenario and log paths come from the environment.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const surface = args.includes('--surface') ? `:${args[args.indexOf('--surface') + 1]}` : '';
const key = `${args[0]}${surface}`;
const scenario = JSON.parse(readFileSync(process.env.FAKE_AD_SCENARIO, 'utf8'));
const log = process.env.FAKE_AD_LOG;
const previous = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const count = previous.filter((entry) => entry.key === key).length;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');
appendFileSync(log, `${JSON.stringify({ key, args, stdin, home: process.env.AGENT_DESKTOP_HOME })}\n`);
const answers = scenario[key] ?? [{ ok: true, data: {} }];
let answer = answers[Math.min(count, answers.length - 1)];
// `spawn`: start a process standing in for the launched app, with the environment the launch passed (--env=K=V).
if (answer.spawn === true) {
  const env = { ...process.env };
  for (const arg of args) if (arg.startsWith('--env=')) {
    const [name, ...value] = arg.slice('--env='.length).split('=');
    env[name] = value.join('=');
  }
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { env, detached: true, stdio: 'ignore' });
  child.unref();
  appendFileSync(`${log}.spawned`, `${child.pid}\n`);
}
// `spawnedApps`: list the processes `spawn` started as running copies of an app.
if (answer.spawnedApps !== undefined) {
  const pids = existsSync(`${log}.spawned`) ? readFileSync(`${log}.spawned`, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  answer = { ok: true, data: { apps: pids.map((pid) => ({ ...answer.spawnedApps, pid, process_instance: `spawned-${pid}` })) } };
}
if (answer.sleepMs !== undefined) await new Promise((resolve) => setTimeout(resolve, answer.sleepMs));
if (answer.noEnvelope === true) process.exit(1);
process.stdout.write(`${JSON.stringify({ version: '2.6', command: args[0], ...answer.envelope ?? answer })}\n`);
process.exitCode = answer.ok === false ? 1 : 0;
