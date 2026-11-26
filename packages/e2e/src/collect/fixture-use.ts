/**
 * The fixture rules that need a target, checked at selection: once the pairs
 * that run are known, and before any worker starts. Only a pair that runs is
 * checked, so a file whose `beforeAll` names `app` and is skipped on a web
 * target (`platforms`, `test.skipIf`) stays valid there.
 */

import type { ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import { collectedActors, type PlannedActor } from './actors.ts';
import type { Collection, CollectedTest } from './collect.ts';
import { declarationSite, FixtureUseError } from './fixture-errors.ts';
import { planAttempt, planSuiteHook, type FixturePlan } from './fixture-plan.ts';
import { hooksFor, type ModuleRegistration, type RegisteredHook, type SuiteHook, type TestHook } from './registry.ts';
import type { TestTargetPair } from './select.ts';

function isSuiteHook(hook: RegisteredHook): hook is SuiteHook {
  return hook.kind === 'beforeAll' || hook.kind === 'afterAll';
}

/** What one test's attempts set up on one target, and the actors they open there (`collect/actors.ts`). */
interface PlannedAttempt {
  readonly plan: FixturePlan;
  readonly actors: readonly PlannedActor[];
}

/**
 * The fixture plan of each collected test's attempts on each target, made
 * one time however many agents and repeats the test runs as, and however
 * many of selection's steps read it. A fixture rule a test breaks, an
 * actor's among them, is told the way selection reports it: a
 * `COLLECTION_ERROR` that opens with where the code was declared.
 */
export class AttemptPlans {
  private readonly registrations: ReadonlyMap<string, ModuleRegistration>;
  private readonly plans = new Map<string, PlannedAttempt | { readonly error: CollectionError }>();
  /** The suite hooks planned so far, by target: one serves every test of its scope. */
  private readonly plannedHooks = new Map<string, Set<SuiteHook>>();

  constructor(
    collection: Collection,
    private readonly targets: readonly ResolvedTarget[],
    private readonly projectRoot: string,
  ) {
    this.registrations = new Map(collection.files.map((file) => [file.file, file.registration]));
  }

  /** The plan of `test` on `target` and the actors it opens there, or the rule it breaks. */
  plan(test: CollectedTest, target: ResolvedTarget): PlannedAttempt | { readonly error: CollectionError } {
    const key = `${target.name}::${test.id}`;
    let planned = this.plans.get(key);
    if (planned === undefined) {
      planned = this.checked(test, () => {
        const plan = planAttempt(target, test, this.hooks(test).filter((hook): hook is TestHook => !isSuiteHook(hook)));
        return { plan, actors: collectedActors(plan, test, target, this.targets) };
      });
      this.plans.set(key, planned);
    }
    return planned;
  }

  /** Plans the suite hooks of the scopes `test` enters on `target` that no earlier test planned, and returns the rule one breaks. */
  suiteHooks(test: CollectedTest, target: ResolvedTarget): CollectionError | undefined {
    const seen = this.plannedHooks.get(target.name) ?? new Set<SuiteHook>();
    this.plannedHooks.set(target.name, seen);
    const checked = this.checked(test, () => {
      for (const hook of this.hooks(test).filter(isSuiteHook)) {
        if (seen.has(hook)) continue;
        seen.add(hook);
        planSuiteHook(target, hook);
      }
      return undefined;
    });
    return checked?.error;
  }

  private hooks(test: CollectedTest): readonly RegisteredHook[] {
    const registration = this.registrations.get(test.file);
    return registration === undefined ? [] : hooksFor(registration, test);
  }

  /** What `check` returns, or the fixture rule of `test` it found broken, as selection reports it. */
  private checked<Checked>(test: CollectedTest, check: () => Checked): Checked | { readonly error: CollectionError } {
    try {
      return check();
    } catch (cause) {
      if (!(cause instanceof FixtureUseError)) throw cause;
      return { error: new CollectionError(`${declarationSite(cause, this.projectRoot, test.file)}: ${cause.message}`, { cause }) };
    }
  }
}

/**
 * Checks the fixtures of every pair that runs, and of the suite hooks of the
 * scopes it enters, on the pair's target. Throws the first rule one breaks:
 * a name no target in the config has a fixture for, a test fixture named by
 * a suite hook or a worker fixture, a cycle.
 */
export function assertFixtureUse(pairs: readonly TestTargetPair[], plans: AttemptPlans): void {
  for (const { test, target, disposition } of pairs) {
    if (disposition !== 'run') continue;
    const attempt = plans.plan(test, target);
    const broken = 'error' in attempt ? attempt.error : plans.suiteHooks(test, target);
    if (broken !== undefined) throw broken;
  }
}
