/** Shared regular-expression plumbing for the glob, text, and URL matchers. */

/** Escapes one character for literal use inside a regexp source. */
export function escapeRegexpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
