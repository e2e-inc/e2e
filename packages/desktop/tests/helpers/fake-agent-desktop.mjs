#!/usr/bin/env node
// A scripted agent-desktop: answers each command with the next envelope the
// scenario lists for it (the last one repeats), and logs every call with the
// stdin it received. Scenario and log paths come from the environment.
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
const answer = answers[Math.min(count, answers.length - 1)];
if (answer.sleepMs !== undefined) await new Promise((resolve) => setTimeout(resolve, answer.sleepMs));
if (answer.noEnvelope === true) process.exit(1);
process.stdout.write(`${JSON.stringify({ version: '2.6', command: args[0], ...answer.envelope ?? answer })}\n`);
process.exitCode = answer.ok === false ? 1 : 0;
