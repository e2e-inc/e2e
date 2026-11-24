/** Parallel scopes: which tests of one file may run at the same time on separate workers. */

import { describeValue } from '@e2e-dev/core/lib/config/validate';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import { unknownKeyMessage } from '@e2e-dev/core/lib/internal/options';
import type { GroupNode, ModuleRegistration } from './registry.ts';

/**
 * Checks a `parallel` value about to be set on a scope: the file, or a group
 * whose `serial` is given.
 */
export function checkParallel(api: string, value: unknown, serial: boolean): asserts value is boolean | undefined {
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    throw new CollectionError(`${api}: parallel must be true or false, got ${describeValue(value)}`);
  }
  if (serial) {
    throw new CollectionError(`${api}: parallel cannot be set on a serial group, which runs as one unit on one worker`);
  }
}

/**
 * The `parallel` a `describe.configure()` call sets on its scope, which has
 * `current` so far and is a serial group or not; undefined when the call
 * sets none.
 */
export function configuredParallel(options: unknown, current: boolean | undefined, serial: boolean): boolean | undefined {
  const api = 'describe.configure()';
  if (typeof options !== 'object' || options === null) throw new CollectionError(`${api} takes an options object, e.g. { parallel: true }`);
  if ('mode' in options) {
    throw new CollectionError(`${api} takes no mode: use { parallel: true } for 'parallel', { parallel: false } for 'default', and describe(title, { serial: true }, fn) for 'serial'`);
  }
  const unknown = unknownKeyMessage(api, options, ['parallel']);
  if (unknown !== undefined) throw new CollectionError(unknown);
  const { parallel } = options as { parallel?: unknown };
  checkParallel(api, parallel, serial);
  if (parallel !== undefined && current !== undefined) throw new CollectionError(`${api}: parallel is already set for this scope`);
  return parallel;
}

/**
 * Refuses a parallel group inside a scope that runs in order, as the tests
 * of a serial group or a `parallel: false` scope stay on one worker. Checked
 * once the file has registered, since `describe.configure()` may set a
 * scope's `parallel` after the groups inside it were declared.
 */
export function checkParallelNesting(groups: readonly GroupNode[], fileParallel: boolean | undefined): void {
  for (const group of groups) {
    if (group.parallel !== true) continue;
    const around: GroupNode[] = [];
    for (let parent = group.parent; parent !== undefined; parent = parent.parent) around.push(parent);
    const where = `describe ${JSON.stringify(group.title)}`;
    if (around.some((parent) => parent.serial)) {
      throw new CollectionError(`${where}: parallel: true cannot be set inside a serial group, which runs as one unit on one worker`);
    }
    if (fileParallel === false || around.some((parent) => parent.parallel === false)) {
      throw new CollectionError(`${where}: parallel: true cannot be set inside a scope with parallel: false, which runs in order on one worker`);
    }
  }
}

/** Where a test sits among its file's parallel scopes. */
export interface ParallelPlacement {
  /** Whether a scope around the test, a group or the file, has `parallel: true`. */
  readonly declared: boolean;
  /**
   * The outermost scope around the test that runs in order on one worker, a
   * serial group or a scope with `parallel: false`, by a name of its own
   * within the file; undefined when no such scope is around it. Serial
   * groups with one title path share a name, as they share the serial group
   * id their records carry: one unit runs them, so the id stays one record.
   */
  readonly ordered: string | undefined;
  /** Whether a scope around the test has a `beforeAll` or `afterAll` hook. */
  readonly suiteHooks: boolean;
}

/** The placement of each test of one registration, from the groups around the test, outermost first. */
export function parallelPlacements(registration: ModuleRegistration): (groups: readonly GroupNode[]) => ParallelPlacement {
  const hooked = new Set(
    registration.hooks.filter((hook) => hook.kind === 'beforeAll' || hook.kind === 'afterAll').map((hook) => hook.group),
  );
  const names = new Map<GroupNode | string, string>();
  const nameOf = (scope: GroupNode | string): string => {
    let name = names.get(scope);
    if (name === undefined) {
      name = `group-${names.size}`;
      names.set(scope, name);
    }
    return name;
  };
  return (groups) => {
    const at = groups.findIndex((group) => group.serial || group.parallel === false);
    const ordered = groups[at];
    // A serial group is known by its title path, a `parallel: false` group by itself.
    const scope = ordered?.serial === true ? JSON.stringify(groups.slice(0, at + 1).map((group) => group.title)) : ordered;
    return {
      declared: registration.parallel === true || groups.some((group) => group.parallel === true),
      ordered: registration.parallel === false ? 'file' : scope === undefined ? undefined : nameOf(scope),
      suiteHooks: hooked.has(undefined) || groups.some((group) => hooked.has(group)),
    };
  };
}
