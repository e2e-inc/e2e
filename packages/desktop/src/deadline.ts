/**
 * The operation with one deadline: `timeoutMs` reads what is left of the
 * budget the call started with, so every call an action makes (a press
 * that focuses first, a type that clears first) shares one budget instead
 * of each getting the whole of it.
 */
export function withDeadline<T extends { readonly timeoutMs: number }>(operation: T): T {
  const deadline = Date.now() + operation.timeoutMs;
  return {
    ...operation,
    get timeoutMs() {
      return Math.max(0, deadline - Date.now());
    },
  };
}
