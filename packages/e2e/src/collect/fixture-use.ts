/**
 * The fixture rules that need a target, checked at selection: once the pairs
 * that run are known, and before any worker starts. Only a pair that runs is
 * checked, so a file that names `device` and is skipped on a web target
 * (`platforms`, `requires`, `test.skipIf`) stays valid there.
 */

import type { ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import type { Collection, CollectedTest } from './collect.ts';
import { declarationSite, FixtureUseError } from './fixture-errors.ts';
import { planAttempt, planSuiteHook, type FixturePlan } from './fixture-plan.ts';
import { hooksFor, type ModuleRegistration, type RegisteredHook, type SuiteHook, type TestHook } from './registry.ts';
import type { TestTargetPair } from './select.ts';

function isSuiteHook(hook: RegisteredHook): hook is SuiteHook {
  return hook.kind === 'beforeAll' || hook.kind === 'afterAll';
}

/**
 * The fixture plan of each collected test's attempts on each target, made
 * one time however many agents and repeats the test runs as, and however
 * many of selection's steps read it. A fixture rule a test breaks is told
 * the way selection reports it: a `COLLECTION_ERROR` that opens with where
 * the code was declared.
 */
export class AttemptPlans {
  private readonly registrations: ReadonlyMap<string, ModuleRegistration>;
  private readonly plans = new Map<string, { readonly plan: FixturePlan } | { readonly error: CollectionError }>();

  constructor(
    collection: Collection,
    private readonly projectRoot: string,
  ) {
    this.registrations = new Map(collection.files.map((file) => [file.file, file.registration]));
  }

  /** The hooks that apply to `test`, suite hooks among them. */
  hooks(test: CollectedTest): readonly RegisteredHook[] {
    const registration = this.registrations.get(test.file);
    return registration === undefined ? [] : hooksFor(registration, test);
  }

  /** The plan of `test` on `target`, or the rule it breaks there. */
  plan(test: CollectedTest, target: ResolvedTarget): { readonly plan: FixturePlan } | { readonly error: CollectionError } {
    const key = `${target.name}::${test.id}`;
    let planned = this.plans.get(key);
    if (planned === undefined) {
      planned = this.checked(test, () => ({ plan: planAttempt(target, test, this.hooks(test).filter((hook): hook is TestHook => !isSuiteHook(hook))) }));
      this.plans.set(key, planned);
    }
    return planned;
  }

  /** What `check` returns, or the fixture rule of `test` it found broken, as selection reports it. */
  checked<Checked>(test: CollectedTest, check: () => Checked): Checked | { readonly error: CollectionError } {
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
 * a name the target has no fixture for, a test fixture named by a suite hook
 * or a worker fixture, a cycle, a fixture whose declared scope is not the
 * one of the fixture it extends.
 */
export function assertFixtureUse(pairs: readonly TestTargetPair[], plans: AttemptPlans): void {
  // A suite hook serves every test of its scope.
  const plannedHooks = new Map<string, Set<SuiteHook>>();
  for (const { test, target, disposition } of pairs) {
    if (disposition !== 'run') continue;
    const seen = plannedHooks.get(target.name) ?? new Set<SuiteHook>();
    plannedHooks.set(target.name, seen);
    const attempt = plans.plan(test, target);
    if ('error' in attempt) throw attempt.error;
    const broken = plans.checked(test, () => {
      for (const hook of plans.hooks(test).filter(isSuiteHook)) {
        if (seen.has(hook)) continue;
        seen.add(hook);
        planSuiteHook(target, hook);
      }
      return undefined;
    });
    if (broken !== undefined) throw broken.error;
  }
}
