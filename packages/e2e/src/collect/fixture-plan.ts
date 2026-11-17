/**
 * Which fixtures a piece of test code needs, and in what order: the ones its
 * functions name, the ones those fixtures name in turn, and the `auto` ones.
 * Planning runs no fixture, so the rules it enforces (a name the target has,
 * a suite hook or worker fixture that reads worker fixtures only, no cycle)
 * fail at collection, and again in the worker before anything is set up.
 */

import { builtInFixtures, DECLARED_BUILT_INS, type BuiltInFixtures, type BuiltInTarget } from '@e2e-dev/core/lib/run/fixtures';
import type { FixtureScope } from '@e2e-dev/core/lib/types';
import type { SourceLocation } from '@e2e-dev/core/lib/internal/source';
import { FixtureUseError } from './fixture-names.ts';
import type { FixtureDefinition, RegisteredHook, RegisteredTest, SuiteHook, TestHook } from './registry.ts';

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
  readonly target: BuiltInTarget;
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

/** What one name a function reads resolved to. */
type Dependency = { readonly definition: FixtureDefinition } | { readonly definition?: undefined; readonly engineBacked: boolean };

const SCOPE_RULE = 'beforeAll, afterAll, and worker fixtures see worker fixtures only, since a test fixture is set up for one test. Use it in beforeEach, or save the state it builds with test.setup()';

/** A scope the planner may not know yet: before a target is, a fixture that follows the engine is `unresolved`. */
type PlannedScope = FixtureScope | 'unresolved';

/**
 * Walks the fixtures a plan needs, each after the fixtures it names.
 * `builtIns` are the target's, or, while a `test.extend()` call is checked,
 * the ones known before any target is.
 */
class Planner {
  readonly order: FixtureDefinition[] = [];
  readonly engineBacked = new Set<FixtureDefinition>();
  private readonly state = new Map<FixtureDefinition, 'visiting' | 'done'>();
  private readonly scopes = new Map<FixtureDefinition, PlannedScope>();

  constructor(
    private readonly chain: readonly FixtureDefinition[],
    private readonly builtIns: Omit<BuiltInFixtures, 'attemptless'>,
  ) {}

  /**
   * The chain fixture `name` stands for. A fixture that names itself reads
   * the one of its name declared before it, which it extends; any other
   * reader gets the last one declared, so an override reaches everyone.
   */
  declared(name: string, from?: FixtureDefinition): FixtureDefinition | undefined {
    const before = from !== undefined && from.name === name ? this.chain.slice(0, this.chain.indexOf(from)) : this.chain;
    return before.findLast((definition) => definition.name === name);
  }

  /**
   * The scope of `definition`: the one it declares, else the one of the
   * fixture it extends (an earlier one of its name, or a built-in), else
   * `test`. A declared scope that differs from the extended fixture's is an
   * error naming both.
   */
  scopeOf(definition: FixtureDefinition): PlannedScope {
    const known = this.scopes.get(definition);
    if (known !== undefined) return known;
    const { name } = definition;
    const base = this.declared(name, definition);
    const extended = base === undefined ? this.builtIns.scope(name) : this.scopeOf(base);
    if (definition.scope !== undefined && extended !== undefined && extended !== 'unresolved' && extended !== definition.scope) {
      const what = base === undefined ? `the built-in "${name}"` : `the fixture "${name}" of an earlier test.extend()`;
      throw new FixtureUseError(
        `fixture "${name}" is declared with scope '${definition.scope}', but it extends ${what}, a ${extended} fixture${this.onTarget()}: a fixture that extends another keeps its scope`,
        definition.source,
      );
    }
    const scope = definition.scope ?? extended ?? 'test';
    this.scopes.set(definition, scope);
    return scope;
  }

  private onTarget(): string {
    return this.builtIns.targetName === undefined ? '' : ` on target "${this.builtIns.targetName}"`;
  }

  /**
   * Resolves `name`, which the code `what` describes reads; `source` is
   * where that code is. `scope` is how long the code lives: a suite hook or a
   * worker fixture (`worker`) cannot read a test fixture. `from` is the
   * fixture reading it, which sees the fixtures of its own `test.extend()`
   * call and of the ones before it, and every fixture that extends a built-in.
   */
  read(name: string, what: string, source: SourceLocation | undefined, scope: PlannedScope, from?: FixtureDefinition): Dependency {
    const builtIn = this.builtIns.scope(name);
    const definition = this.declared(name, from);
    const visible = this.chain.filter((each) => from === undefined || each.layer <= from.layer);
    if (definition === undefined && builtIn === undefined) {
      const available = [...new Set([...this.builtIns.names, ...visible.filter((each) => each !== from).map((each) => each.name)])].toSorted();
      throw new FixtureUseError(`${what} names "${name}": ${this.builtIns.missing(name, available)}`, source);
    }
    if (definition !== undefined && builtIn === undefined && !visible.some((each) => each.name === name)) {
      throw new FixtureUseError(
        `${what} names "${name}", which a later test.extend() declares: a fixture sees the fixtures of its own extend() call and of the ones before it`,
        source,
      );
    }
    if (scope === 'worker' && (definition === undefined ? builtIn : this.scopeOf(definition)) === 'test') {
      throw new FixtureUseError(`${what} names "${name}", a test fixture${this.onTarget()}: ${SCOPE_RULE}`, source);
    }
    return definition === undefined ? { engineBacked: this.builtIns.needsAttempt(name) } : { definition };
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
    const what = describeFixture(definition.name, scope === 'unresolved' ? definition.scope : scope);
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
  const planner = new Planner(chain, DECLARED_BUILT_INS);
  for (const definition of added) planner.visit(definition);
}

interface PlanRequest {
  readonly target: BuiltInTarget;
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
  const builtIns = builtInFixtures(target);
  const reach = new Planner(chain, builtIns);
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
  const ordered = new Planner(chain, builtIns);
  for (const definition of chain) if (needed.has(definition)) ordered.visit(definition);
  const scopes = new Map<FixtureDefinition, FixtureScope>();
  const bases = new Map<FixtureDefinition, FixtureDefinition>();
  for (const definition of ordered.order) {
    const planned = reach.scopeOf(definition);
    // A target resolves every scope: `unresolved` is the answer before one is known.
    if (planned !== 'unresolved') scopes.set(definition, planned);
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
export function planAttempt(target: BuiltInTarget, test: Pick<RegisteredTest, 'kind' | 'titlePath' | 'names' | 'source' | 'fixtures'>, hooks: readonly TestHook[]): FixturePlan {
  return planFixtures({ target, chain: test.fixtures, scope: 'test', users: [...hooks, test] });
}

/** The plan of one `beforeAll` or `afterAll` hook, over the chain it was registered through. */
export function planSuiteHook(target: BuiltInTarget, hook: SuiteHook): FixturePlan {
  return planFixtures({ target, chain: hook.fixtures, scope: 'worker', users: [hook] });
}
