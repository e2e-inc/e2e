/** How a test tells which page function a `script.callFunction` the driver sent is a call of. */

/**
 * The browsing context of `params` when they are a call of the page function
 * `fn`, undefined for any other command. A call passed a node goes out
 * behind a check of its nodes (`inOwnDocument` in `driver/script.ts`), so
 * the function's source is looked for inside the declaration.
 */
export function callOf(fn: { toString(): string }, params: object): string | undefined {
  const call = params as { functionDeclaration?: unknown; target?: { context?: string } };
  return typeof call.functionDeclaration === 'string' && call.functionDeclaration.includes(fn.toString()) ? call.target?.context : undefined;
}
