import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The scripted agent-desktop executable. */
export const FAKE_BINARY = path.resolve(import.meta.dirname, 'fake-agent-desktop.mjs');

/** One call the fake received. */
export interface FakeCall {
  readonly key: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly home?: string;
}

/** Answers by command (`snapshot`, `snapshot:menu`, `select`): each call takes the next, the last repeats. */
export type Scenario = Record<string, readonly unknown[]>;

/** The directories scenarios were written to, removed by `cleanupFakes`. */
const directories: string[] = [];

/** Removes every scenario directory written so far; call it after each test, once its fake processes have stopped. */
export function cleanupFakes(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

/** A scenario on disk and the environment that points the fake at it. */
export function fakeScenario(scenario: Scenario): { env: Record<string, string>; calls: () => FakeCall[]; spawned: () => number[] } {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-fake-agent-desktop-'));
  directories.push(directory);
  const file = path.join(directory, 'scenario.json');
  const log = path.join(directory, 'calls.jsonl');
  writeFileSync(file, JSON.stringify(scenario));
  return {
    env: { ...(process.env as Record<string, string>), FAKE_AD_SCENARIO: file, FAKE_AD_LOG: log },
    spawned: () => {
      try {
        return readFileSync(`${log}.spawned`, 'utf8').split('\n').filter(Boolean).map(Number);
      } catch {
        return [];
      }
    },
    calls: () => {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeCall);
      } catch {
        return [];
      }
    },
  };
}

/** A snapshot fixture's `data`, as a scenario answer. */
export function snapshotAnswer(name: string): unknown {
  return { ok: true, data: JSON.parse(readFileSync(new URL(`../fixtures/snapshots/${name}.json`, import.meta.url), 'utf8')) };
}

/** A failed envelope. */
export function failure(code: string, delivery: 'not_delivered' | 'delivered_unverified' | 'unknown', message = `${code} from the fake`): unknown {
  return { ok: false, error: { code, message, disposition: { delivery, retry: delivery === 'not_delivered' ? 'safe' : 'unsafe' } } };
}
