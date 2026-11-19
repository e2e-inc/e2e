import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

/** A scenario on disk and the environment that points the fake at it. */
export function fakeScenario(scenario: Scenario): { env: Record<string, string>; calls: () => FakeCall[] } {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-fake-agent-desktop-'));
  const file = path.join(directory, 'scenario.json');
  const log = path.join(directory, 'calls.jsonl');
  writeFileSync(file, JSON.stringify(scenario));
  return {
    env: { ...(process.env as Record<string, string>), FAKE_AD_SCENARIO: file, FAKE_AD_LOG: log },
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
