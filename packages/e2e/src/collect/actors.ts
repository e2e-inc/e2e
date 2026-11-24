/**
 * The actors a test names: more sessions beside its own, each an `actor()`
 * fixture of the chain it was registered through. A fixture plan lists the
 * ones a test needs, named directly or through a fixture or a hook; here
 * each is resolved against the config, so a target it cannot run on is a
 * collection error and never a failure inside a launch budget.
 */

import type { ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import { didYouMean } from '@e2e-dev/core/lib/internal/suggest';
import type { Collection, CollectedTest } from './collect.ts';
import { declarationSite, FixtureUseError } from './fixture-errors.ts';
import { planAttempt, type FixturePlan } from './fixture-plan.ts';
import { hooksFor, type FixtureDefinition, type ModuleRegistration, type TestHook } from './registry.ts';

/** One actor a test opens. */
export interface PlannedActor {
  /** The fixture's name: what its steps, its video, and its recordings carry. */
  readonly name: string;
  readonly definition: FixtureDefinition;
  /** The saved session it starts from; undefined for a signed-out one. */
  readonly session: string | undefined;
  /** The target it runs on. */
  readonly target: ResolvedTarget;
  /** Whether that is the test's own target, where the actor is one more attempt on the worker's engine. */
  readonly own: boolean;
}

/**
 * The actors `plan` sets up for a test on `own`, each on the target it
 * names among `targets`, or on `own`. Throws a `FixtureUseError` for a target
 * the config does not have, an actor of another engine than its target
 * runs, an engine that cannot open one beside the test or two beside each
 * other, another target whose engine instance a second target shares, and
 * a session an engine cannot restore.
 */
export function plannedActors(plan: FixturePlan, own: ResolvedTarget, targets: readonly ResolvedTarget[]): PlannedActor[] {
  const actors = resolvedActors(plan, own, targets);
  // Another target's engine is one instance for the worker: without `actors` it runs one attempt, so it serves one actor.
  for (const actor of actors) {
    const earlier = actors.find((other) => other !== actor && !other.own && other.target.name === actor.target.name);
    if (earlier === undefined || actor.own || actors.indexOf(earlier) > actors.indexOf(actor) || actor.target.engine?.capabilities.has('actors') === true) continue;
    throw new FixtureUseError(
      `actors "${earlier.name}" and "${actor.name}" both run on target "${actor.target.name}", and engine ${actor.target.engine?.name ?? 'none'}, as configured, drives one session at a time: give each a target of its own`,
      actor.definition.source,
    );
  }
  return actors;
}

function resolvedActors(plan: FixturePlan, own: ResolvedTarget, targets: readonly ResolvedTarget[]): PlannedActor[] {
  return plan.order.flatMap(({ definition }) => {
    const declared = definition.actor;
    if (declared === undefined) return [];
    const { name } = definition;
    const refuse = (message: string): never => {
      throw new FixtureUseError(`actor "${name}" ${message}`, definition.source);
    };
    const named = declared.target === undefined ? own : targets.find((target) => target.name === declared.target);
    if (named === undefined) {
      const known = targets.map((target) => target.name);
      return refuse(`names target "${declared.target}", and the config has no target of that name; it has ${known.join(', ')}${didYouMean(declared.target ?? '', known)}`);
    }
    const isOwn = named.name === own.name;
    const engine = named.engine;
    if (engine?.name !== declared.engine) {
      const runs = `runs engine ${engine?.name ?? 'none'}`;
      return refuse(
        declared.target === undefined
          ? `is a ${declared.engine} actor, and the test's target "${own.name}" ${runs}: name the ${declared.engine} target it runs on, as in actor({ target: '...' })`
          : `is a ${declared.engine} actor, and target "${named.name}", which it names, ${runs}: use the actor() of that engine's package`,
      );
    }
    // One engine instance is one worker's: initialized again for the actor, it would serve the app of neither target.
    const sharing = isOwn ? undefined : targets.find((target) => target !== named && target.engine === engine);
    if (sharing !== undefined) {
      return refuse(
        `runs on target "${named.name}", which shares its engine instance with target "${sharing.name}": give the target an engine of its own, a second ${engine.name}() call in the config`,
      );
    }
    if (isOwn && !engine.capabilities.has('actors')) {
      return refuse(
        `runs on the test's own target "${own.name}", and engine ${engine.name}, as configured, drives one session at a time there: name another target of the config for it, as in actor({ target: '...' })`,
      );
    }
    if (declared.session !== undefined && !engine.capabilities.has('state')) {
      return refuse(`restores session "${declared.session}", and target "${named.name}" cannot restore one: engine ${engine.name}, as configured, has no state capability`);
    }
    return [{ name, definition, session: declared.session, target: named, own: isOwn }];
  });
}

/**
 * The actors of each collected test on each target, planned once per test
 * and target however many agents and repeats it runs as.
 */
export class ActorPlans {
  private readonly registrations: ReadonlyMap<string, ModuleRegistration>;
  private readonly planned = new Map<string, { readonly actors: readonly PlannedActor[] } | { readonly error: FixtureUseError }>();

  constructor(
    collection: Collection,
    private readonly targets: readonly ResolvedTarget[],
    private readonly projectRoot: string,
  ) {
    this.registrations = new Map(collection.files.map((file) => [file.file, file.registration]));
  }

  /**
   * The actors `test` opens on `target`. A fixture rule the test breaks
   * there, an actor's among them, is a `COLLECTION_ERROR` that opens with
   * where the code was declared. So is an actor a test cannot have yet: one
   * in a serial group, whose tests share a single session, and one that
   * restores a session in a setup test, which would need another setup first.
   */
  of(test: CollectedTest, target: ResolvedTarget): readonly PlannedActor[] {
    const planned = this.plan(test, target);
    if ('error' in planned) {
      throw new CollectionError(`${declarationSite(planned.error, this.projectRoot, test.file)}: ${planned.error.message}`, { cause: planned.error });
    }
    return planned.actors;
  }

  /**
   * The saved sessions the actors of `test` restore on `target`, each with
   * the target it is restored on. Empty for a test that cannot be planned
   * there: it does not run there, or `of` reports why.
   */
  sessions(test: CollectedTest, target: ResolvedTarget): readonly ActorSession[] {
    const planned = this.plan(test, target);
    return 'error' in planned ? [] : actorSessions(planned.actors);
  }

  private plan(test: CollectedTest, target: ResolvedTarget): { readonly actors: readonly PlannedActor[] } | { readonly error: FixtureUseError } {
    const key = `${target.name}::${test.id}`;
    const known = this.planned.get(key);
    if (known !== undefined) return known;
    let planned: { readonly actors: readonly PlannedActor[] } | { readonly error: FixtureUseError };
    try {
      planned = { actors: this.resolve(test, target) };
    } catch (cause) {
      if (!(cause instanceof FixtureUseError)) throw cause;
      planned = { error: cause };
    }
    this.planned.set(key, planned);
    return planned;
  }

  private resolve(test: CollectedTest, target: ResolvedTarget): readonly PlannedActor[] {
    // No chain fixture, no actor: most tests, which need no plan here.
    if (!test.fixtures.some((definition) => definition.actor !== undefined)) return [];
    const registration = this.registrations.get(test.file);
    const hooks = registration === undefined ? [] : hooksFor(registration, test).filter((hook): hook is TestHook => hook.kind === 'beforeEach' || hook.kind === 'afterEach');
    const actors = plannedActors(planAttempt(target, test, hooks), target, this.targets);
    const [first] = actors;
    if (first !== undefined && test.serialId !== undefined) {
      throw new FixtureUseError(
        `test ${JSON.stringify(test.titlePath.join(' > '))} is in a serial group and names actor "${first.name}": the group's tests share one session, and an actor is opened for one test`,
        test.source,
      );
    }
    const restoring = test.kind === 'setup' ? actors.find((actor) => actor.session !== undefined) : undefined;
    if (restoring !== undefined) {
      throw new FixtureUseError(
        `setup test ${JSON.stringify(test.titlePath.join(' > '))} names actor "${restoring.name}", which restores session "${restoring.session}": a setup test cannot start from a session another one saves`,
        test.source,
      );
    }
    return actors;
  }
}

/** A saved session an actor restores, and the target it is restored on. */
export interface ActorSession {
  readonly session: string;
  readonly target: ResolvedTarget;
}

/** The saved sessions `actors` restore, each once per target. */
export function actorSessions(actors: readonly PlannedActor[]): readonly ActorSession[] {
  const seen = new Set<string>();
  return actors.flatMap((actor) => {
    if (actor.session === undefined) return [];
    const key = `${actor.target.name}::${actor.session}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ session: actor.session, target: actor.target }];
  });
}
