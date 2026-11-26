/**
 * Secrets across a test and its actor: a value one session resolves from a
 * provider is redacted on the other's screen and in what the other reports,
 * in both directions, and in every file the run writes.
 */

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../src/run/runner.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { contentsUnder, resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const CODE_VALUE = 'one-time-code-771204';

// The value is spelled in parts, so the test file's own text never holds it.
const SUITE = `import { test as base, expect, secrets } from 'e2e';
import { fakeActor as actor } from '../../../helpers/fake-engine.ts';

const CODE_VALUE = ['one', 'time', 'code', '771204'].join('-');
const test = base.extend({ guest: actor() });

test('the actor resolves a value the test then shows', async ({ app, screen, guest }) => {
  await app.open();
  await guest.app.open();
  await guest.screen.getByLabel('Code').fill(secrets.get('CODE'));
  expect(await screen.tree()).toContain('your code is <secret:CODE>');
  // Fails with the value in its label and on the test's own screen.
  await screen.getByRole('button', CODE_VALUE).tap();
});

test('the test resolves a value the actor then shows', async ({ app, screen, guest }) => {
  await app.open();
  await guest.app.open();
  await screen.getByLabel('Code').fill(secrets.get('CODE'));
  expect(await guest.screen.tree()).toContain('your code is <secret:CODE>');
  // Fails with the value in its label and on the actor's screen: both reach the test's report through the actor.
  await guest.screen.getByRole('button', CODE_VALUE).tap();
});
`;

describe('a secret one session of a test resolves, in the other', { timeout: 120_000 }, () => {
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    const fake = createFakeEngine({
      actors: true,
      scene: () => [
        { id: 'sms', role: 'paragraph', name: '', text: `your code is ${CODE_VALUE}` },
        { id: 'code', role: 'textbox', name: 'Code', value: '' },
      ],
    });
    ({ outcome, project } = await runProject(
      { 'tests/secrets.e2e.ts': SUITE },
      { config: engineConfig(fake.engine, { secrets: { CODE: () => CODE_VALUE }, trace: 'on', actionTimeout: 300, assertionTimeout: 200 }) },
    ));
  });

  afterAll(() => project?.cleanup());

  it("redacts a value the actor resolved on the test's own screen and in its failure", () => {
    const attempt = resultByTitle(outcome, 'the actor resolves a value the test then shows').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'LOCATOR_NOT_FOUND', message: expect.stringContaining('<secret:CODE>') });
    expect(attempt.steps.at(-1)).toMatchObject({ label: expect.stringContaining('<secret:CODE>') });
  });

  it("redacts a value the test resolved on the actor's screen and in what the actor reports", () => {
    const attempt = resultByTitle(outcome, 'the test resolves a value the actor then shows').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'LOCATOR_NOT_FOUND', message: expect.stringContaining('<secret:CODE>') });
    expect(attempt.steps.at(-1)).toMatchObject({ actor: 'guest', label: expect.stringContaining('<secret:CODE>') });
  });

  it('keeps the value out of the report and of every file the run wrote', () => {
    expect(JSON.stringify(outcome)).not.toContain(CODE_VALUE);
    const written = contentsUnder(path.join(project.dir, '.e2e'));
    expect(written.length).toBeGreaterThan(0);
    for (const [file, content] of written) expect(content, file).not.toContain(CODE_VALUE);
  });
});
