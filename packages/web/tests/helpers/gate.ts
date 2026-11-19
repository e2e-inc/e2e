/** A promise a test settles by hand, to hold one side of a race until the other reached the point under test. */

/** What waits at a gate, and what lets it through. */
export interface Gate<T = void> {
  /** Pending until `release` runs, then resolved with what `release` was given. */
  readonly held: Promise<T>;
  /** Resolves `held`; only the first call counts. */
  readonly release: (value: T) => void;
}

/** A gate shut until the test releases it, with a value when `T` names one. */
export function gate<T = void>(): Gate<T> {
  let release!: (value: T) => void;
  const held = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { held, release };
}
