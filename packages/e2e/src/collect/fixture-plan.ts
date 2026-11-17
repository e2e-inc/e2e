/**
 * Which fixtures a piece of test code needs, and in what order: the ones its
 * functions name, the ones those fixtures name in turn, and the `auto` ones.
 * Planning runs no fixture, so the rules it enforces (a name the target has,
 * a suite hook or worker fixture that reads worker fixtures only, no cycle)
 * fail at collection, and again in the worker before anything is set up.
 */

import type { EngineIsolation } from '@e2e-dev/core/lib/engine/index';
import { CORE_FIXTURES, unknownFixtureMessage } from '@e2e-dev/core/lib/run/fixtures';
import type { FixtureScope } from '@e2e-dev/core/lib/types';
import type { SourceLocation } from '@e2e-dev/core/lib/internal/source';
import { FixtureUseError } from './fixture-names.ts';
import type { FixtureDefinition, RegisteredHook, RegisteredTest, SuiteHook, TestHook } from './registry.ts';

/** What the pool reads of a target: its name, its platform, and its engine's fixtures and isolation. */
export interface FixtureTarget {
  readonly name: string;
  readonly platform: string;
  readonly engine?:
    | {
        readonly name: string;
        readonly isolation?: EngineIsolation | undefined;
        readonly fixtures?: Readonly<Record<string, unknown>> | undefined;
      }
    | undefined;
}

/**
 * The scope a built-in fixture has on every target, or undefined when it
 * follows the engine: core declares it for the core fixtures (`platform`
 * never changes, `agent` and `session` belong to one attempt), and an
 * engine's own fixtures always follow the engine.
 */
function fixedScope(name: string): FixtureScope | undefined {
  const scope = Object.hasOwn(CORE_FIXTURES, name) ? CORE_FIXTURES[name as keyof typeof CORE_FIXTURES].scope : 'engine';
  return scope === 'engine' ? undefined : scope;
}

/**
 * The scope of a built-in fixture on `target`: its fixed one, or, for `app`,
 * `screen`, and the engine's fixtures, as long as the state behind them
 * lives, which the engine declares (`isolation`).
 */
export function builtInScope(target: FixtureTarget, name: string): FixtureScope {
  return fixedScope(name) ?? (target.engine?.isolation === 'worker' ? 'worker' : 'test');
}

/** Every built-in fixture name on `target`: the core ones, then the engine's. */
export function builtInNames(target: FixtureTarget): readonly string[] {
  return [...Object.keys(CORE_FIXTURES), ...Object.keys(target.engine?.fixtures ?? {})];
}

/** A registered test body or hook, as the planner reads it: the fixtures its function names, and where it is. */
type FixtureUser = (Pick<RegisteredTest, 'kind' | 'titlePath'> | Pick<RegisteredHook, 'kind'>) & {
  readonly names: readonly string[];
  readonly source?: SourceLocation | undefined;
};

/** How an error names a test body or a hook: `test "signs in"`, `setup test "auth"`, `beforeEach hook`. */
export function describeUser(user: Pick<RegisteredTest, 'kind' | 'titlePath'> | Pick<RegisteredHook, 'kind'>): string {
  if (!('titlePath' in user)) return `${user.kind} hook`;
  return `${user.kind === 'setup' ? 'setup test' : 'test'} ${JSON.stringify(user.titlePath.join(' > '))}`;
}

/** How an error names a `test.extend()` fixture of `scope`: `fixture "page"`, `worker fixture "database"`. */
export function describeFixture(name: string, scope: FixtureScope | undefined): string {
  return `${scope === 'worker' ? 'worker fixture' : 'fixture'} "${name}"`;
}

/** What to set up for one piece of test code, and whether it reaches the engine. */
export interface FixturePlan {
  readonly target: FixtureTarget;
  /** The `test.extend()` chain the plan was made over. */
  readonly chain: readonly FixtureDefinition[];
  /** `test` for an attempt (its hooks and body), `worker` for a suite hook. */
  readonly scope: FixtureScope;
  /** The chain's fixtures to set up: in declaration order, each after the fixtures it names. */
  readonly order: readonly FixtureDefinition[];
  /** The scope each planned fixture has on the target: the one it declares, or the one of the fixture it extends. */
  readonly scopes: ReadonlyMap<FixtureDefinition, FixtureScope>;
  /**
   * For a planned fixture that names itself, the earlier fixture of its name
   * whose value it receives. One that names itself and is not here receives
   * the built-in.
   */
  readonly bases: ReadonlyMap<FixtureDefinition, FixtureDefinition>;
  /**
   * Whether the code, or a fixture it needs, names a built-in fixture the
   * engine backs: any but `platform`. Code that names none never touches the
   * engine, so a suite hook needs no attempt for it.
   */
  readonly usesEngine: boolean;
  /** The planned fixtures that name an engine-backed built-in, themselves or through a fixture they name. */
  readonly engineBacked: ReadonlySet<FixtureDefinition>;
}

/** The fixtures of one chain on one target; no target while a `test.extend()` call is checked. */
interface Pool {
  readonly target: FixtureTarget | undefined;
  readonly chain: readonly FixtureDefinition[];
}

/** What one name a function reads resolved to. */
type Dependency = { readonly definition: FixtureDefinition } | { readonly definition?: undefined; readonly engineBacked: boolean };

const SCOPE_RULE = 'beforeAll, afterAll, and worker fixtures see worker fixtures only, since a test fixture is set up for one test. Use it in beforeEach, or save the state it builds with test.setup()';

/** Walks the fixtures a plan needs, each after the fixtures it names. */
class Planner {
  readonly order: FixtureDefinition[] = [];
  readonly engineBacked = new Set<FixtureDefinition>();
  private readonly state = new Map<FixtureDefinition, 'visiting' | 'done'>();
  private readonly scopes = new Map<FixtureDefinition, FixtureScope | undefined>();

  constructor(private readonly pool: Pool) {}

  /**
   * The chain fixture `name` stands for. A fixture that names itself reads
   * the one of its name declared before it, which it extends; any other
   * reader gets the last one declared, so an override reaches everyone.
   */
  declared(name: string, from?: FixtureDefinition): FixtureDefinition | undefined {
    const { chain } = this.pool;
    const before = from !== undefined && from.name === name ? chain.slice(0, chain.indexOf(from)) : chain;
    return before.findLast((definition) => definition.name === name);
  }

  /**
   * The scope `definition` has on the target: the one it declares, else the
   * one of the fixture it extends (an earlier one of its name, or a
   * built-in), else `test`. Undefined while no target is known and the name
   * may be an engine's. A declared scope that differs from the extended
   * fixture's is an error naming both.
   */
  scopeOf(definition: FixtureDefinition): FixtureScope | undefined {
    if (this.scopes.has(definition)) return this.scopes.get(definition);
    const { target } = this.pool;
    const { name } = definition;
    const base = this.declared(name, definition);
    const builtIn = target === undefined ? Object.hasOwn(CORE_FIXTURES, name) : builtInNames(target).includes(name);
    const extended = base !== undefined ? this.scopeOf(base) : target === undefined ? fixedScope(name) : builtIn ? builtInScope(target, name) : undefined;
    if (definition.scope !== undefined && extended !== undefined && extended !== definition.scope) {
      const what = base !== undefined ? `the fixture "${name}" of an earlier test.extend()` : `the built-in "${name}"`;
      throw new FixtureUseError(
        `fixture "${name}" is declared with scope '${definition.scope}', but it extends ${what}, a ${extended} fixture${this.onTarget()}: a fixture that extends another keeps its scope`,
        definition.source,
      );
    }
    // Before a target is known, a plain function may extend a fixture whose
    // scope follows the engine: `app`, `screen`, or one an engine contributes.
    const scope = definition.scope ?? extended ?? (target === undefined ? undefined : 'test');
    this.scopes.set(definition, scope);
    return scope;
  }

  private onTarget(): string {
    return this.pool.target === undefined ? '' : ` on target "${this.pool.target.name}"`;
  }

  /**
   * Resolves `name`, which the code `what` describes reads; `source` is
   * where that code is. `scope` is how long the code lives: a suite hook or a
   * worker fixture (`worker`) cannot read a test fixture. `from` is the
   * fixture reading it, which sees the fixtures of its own `test.extend()`
   * call and of the ones before it, and every fixture that extends a built-in.
   */
  read(name: string, what: string, source: SourceLocation | undefined, scope: FixtureScope | undefined, from?: FixtureDefinition): Dependency {
    const { target, chain } = this.pool;
    const builtIn = target !== undefined && builtInNames(target).includes(name);
    const definition = this.declared(name, from);
    const visible = (each: FixtureDefinition): boolean => from === undefined || each.layer <= from.layer;
    let fixtureScope: FixtureScope | undefined;
    if (definition !== undefined) {
      if (target !== undefined && !builtIn && !chain.some((each) => each.name === name && visible(each))) {
        throw new FixtureUseError(
          `${what} names "${name}", which a later test.extend() declares: a fixture sees the fixtures of its own extend() call and of the ones before it`,
          source,
        );
      }
      fixtureScope = this.scopeOf(definition);
    } else if (target === undefined) {
      // Before a target is known, a name the chain lacks may be an engine's, and `app` and `screen` have the engine's scope.
      fixtureScope = fixedScope(name);
    } else if (builtIn) fixtureScope = builtInScope(target, name);
    else {
      const declared = chain.filter((each) => visible(each) && each !== from).map((each) => each.name);
      const available = [...new Set([...builtInNames(target), ...declared])].toSorted();
      throw new FixtureUseError(`${what} names "${name}": ${unknownFixtureMessage(target, name, available)}`, source);
    }
    if (scope === 'worker' && fixtureScope === 'test') {
      throw new FixtureUseError(`${what} names "${name}", a test fixture${this.onTarget()}: ${SCOPE_RULE}`, source);
    }
    return definition === undefined ? { engineBacked: name !== 'platform' } : { definition };
  }

  /** Plans `definition` after the fixtures it names. `path` is the fixtures that led here, outermost first. */
  visit(definition: FixtureDefinition, path: readonly FixtureDefinition[] = []): void {
    const state = this.state.get(definition);
    if (state === 'done') return;
    if (state === 'visiting') {
      const cycle = [...path.slice(path.indexOf(definition)), definition].map((each) => `"${each.name}"`).join(' -> ');
      throw new FixtureUseError(`fixtures depend on each other in a cycle: ${cycle}. A fixture cannot name one that needs it`, definition.source);
    }
    this.state.set(definition, 'visiting');
    const scope = this.scopeOf(definition);
    const what = describeFixture(definition.name, scope);
    for (const name of definition.names) {
      const dependency = this.read(name, what, definition.source, scope, definition);
      if (dependency.definition === undefined) {
        if (dependency.engineBacked) this.engineBacked.add(definition);
        continue;
      }
      this.visit(dependency.definition, [...path, definition]);
      if (this.engineBacked.has(dependency.definition)) this.engineBacked.add(definition);
    }
    this.state.set(definition, 'done');
    this.order.push(definition);
  }
}

/**
 * Checks the fixtures one `test.extend()` call added (`added`, the end of
 * `chain`) as far as they can be before a target is known: each function
 * destructures its first parameter, no two fixtures need each other, a
 * fixture that extends another keeps its scope, and a worker fixture names
 * no fixture known to be a test fixture.
 */
export function checkDeclaredFixtures(chain: readonly FixtureDefinition[], added: readonly FixtureDefinition[]): void {
  const planner = new Planner({ target: undefined, chain });
  for (const definition of added) planner.visit(definition);
}

interface PlanRequest {
  readonly target: FixtureTarget;
  readonly chain: readonly FixtureDefinition[];
  readonly scope: FixtureScope;
  /** The functions about to run with the fixtures. */
  readonly users: readonly FixtureUser[];
}

/**
 * Plans the fixtures of `chain` that `users` need on `target`: the ones they
 * name, the ones those name, and the `auto` ones (a suite hook sets up no
 * test fixture, `auto` or not). Throws a `FixtureUseError`, before anything
 * is set up, for a name the target has no fixture for, a test fixture named
 * by a suite hook or a worker fixture, a cycle, and a fixture whose declared
 * scope is not the one of the fixture it extends.
 */
function planFixtures(request: PlanRequest): FixturePlan {
  const { target, chain, scope, users } = request;
  const pool: Pool = { target, chain };
  const reach = new Planner(pool);
  const named = new Set(chain.filter((definition) => definition.auto && (scope === 'test' || reach.scopeOf(definition) === 'worker')));
  let usesEngine = false;
  for (const user of users) {
    for (const name of user.names) {
      const dependency = reach.read(name, describeUser(user), user.source, scope);
      if (dependency.definition === undefined) usesEngine ||= dependency.engineBacked;
      else named.add(dependency.definition);
    }
  }
  for (const definition of named) reach.visit(definition);
  usesEngine ||= [...named].some((definition) => reach.engineBacked.has(definition));
  // Declaration order over everything reached, so a fixture's place does not
  // depend on who named it, and a suite that names every fixture sets them
  // up as it did before setup was on demand.
  const needed = new Set(reach.order);
  const ordered = new Planner(pool);
  for (const definition of chain) if (needed.has(definition)) ordered.visit(definition);
  const scopes = new Map<FixtureDefinition, FixtureScope>();
  const bases = new Map<FixtureDefinition, FixtureDefinition>();
  for (const definition of ordered.order) {
    scopes.set(definition, reach.scopeOf(definition) ?? 'test');
    const base = definition.names.includes(definition.name) ? reach.declared(definition.name, definition) : undefined;
    if (base !== undefined) bases.set(definition, base);
  }
  return { target, chain, scope, order: ordered.order, scopes, bases, usesEngine, engineBacked: reach.engineBacked };
}

/**
 * The plan of one test attempt, resolved as one unit: what the body and
 * every `beforeEach` and `afterEach` hook that applies name, over the test's
 * own chain. A fixture only an `afterEach` names is set up before the first
 * `beforeEach`, never on the cleanup budget.
 */
export function planAttempt(target: FixtureTarget, test: Pick<RegisteredTest, 'kind' | 'titlePath' | 'names' | 'source' | 'fixtures'>, hooks: readonly TestHook[]): FixturePlan {
  return planFixtures({ target, chain: test.fixtures, scope: 'test', users: [...hooks, test] });
}

/** The plan of one `beforeAll` or `afterAll` hook, over the chain it was registered through. */
export function planSuiteHook(target: FixtureTarget, hook: SuiteHook): FixturePlan {
  return planFixtures({ target, chain: hook.fixtures, scope: 'worker', users: [hook] });
}
