/**
 * The title patterns `--grep`, `--grep-invert`, and the watch `t` prompt
 * read, in one place so the three read the same text the same way.
 */

/**
 * A title pattern as typed: the bare pattern (`checkout`), or
 * `/pattern/flags` for flags (`/checkout/i`). Throws an `Error` whose
 * message says why when it is empty or does not compile.
 */
export function compileTitlePattern(value: string): RegExp {
  const slashed = /^\/(.*)\/([a-z]*)$/su.exec(value);
  const [source, flags] = slashed === null ? [value, ''] : [slashed[1]!, slashed[2]!];
  if (source === '') throw new Error('must be a regular expression');
  try {
    return new RegExp(source, flags);
  } catch (cause) {
    throw new Error(`must be a regular expression: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/**
 * The text `compileTitlePattern` reads back as `pattern`: the bare source
 * when it has no flags and no space at either end, else `/pattern/flags`,
 * since a prompt answer is read trimmed and the slashes keep that space. A
 * source never starts with an unescaped `/`, so the bare form is never read
 * as the slashed one.
 */
export function titlePatternText(pattern: RegExp): string {
  return pattern.flags === '' && pattern.source.trim() === pattern.source ? pattern.source : String(pattern);
}
