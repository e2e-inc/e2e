/**
 * The lexical layer of a selector, shared by the `>>` chain split and the CSS
 * compound split: escapes, quoted strings, and bracketed or parenthesized
 * groups are single tokens, so an escaped combinator, an escaped space, or a
 * hex escape's terminating space never reads as a separator.
 */

import type { CssCombinator, CssNested, CssStep } from '../in-page/select-chain.ts';

/** One lexical unit of a selector, with its source text. */
export type SelectorToken =
  | { readonly kind: 'whitespace'; readonly text: string }
  | { readonly kind: 'combinator'; readonly text: '>' | '+' | '~' }
  | { readonly kind: 'comma'; readonly text: ',' }
  | { readonly kind: 'chain'; readonly text: '>>' }
  | { readonly kind: 'escape'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'group'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string };

const WHITESPACE = /[ \t\n\r\f]/;
const HEX = /[0-9a-fA-F]/;
const SPECIAL = /[ \t\n\r\f>+~,\\"'()[\]]/;

/** The end of the escape that starts at `start` (a backslash): hex digits and one terminating whitespace, or the one code point after it. */
function escapeEnd(source: string, start: number): number {
  let index = start + 1;
  if (index >= source.length) return index;
  if (HEX.test(source[index]!)) {
    const limit = Math.min(source.length, index + 6);
    while (index < limit && HEX.test(source[index]!)) index += 1;
    if (source.startsWith('\r\n', index)) return index + 2;
    return index < source.length && WHITESPACE.test(source[index]!) ? index + 1 : index;
  }
  return index + String.fromCodePoint(source.codePointAt(index)!).length;
}

/** The end of the quoted string that starts at `start`, past its closing quote or at the end of `source` when it has none. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === quote) return index + 1;
    index = char === '\\' ? Math.min(source.length, escapeEnd(source, index)) : index + 1;
  }
  return index;
}

/** The end of the group that starts at `start` (an opening or unmatched closing bracket or parenthesis), where its depth is back to zero. */
function groupEnd(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"' || char === "'") index = stringEnd(source, index);
    else if (char === '\\') index = escapeEnd(source, index);
    else {
      if (char === '(' || char === '[') depth += 1;
      else if (char === ')' || char === ']') depth -= 1;
      index += 1;
      if (depth === 0) return index;
    }
  }
  return index;
}

/** `source` as tokens; their texts joined give `source` back. */
export function tokenizeSelector(source: string): SelectorToken[] {
  const tokens: SelectorToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    let end = index + 1;
    if (WHITESPACE.test(char)) {
      while (end < source.length && WHITESPACE.test(source[end]!)) end += 1;
      tokens.push({ kind: 'whitespace', text: source.slice(index, end) });
    } else if (char === '>' && source[index + 1] === '>') {
      end = index + 2;
      tokens.push({ kind: 'chain', text: '>>' });
    } else if (char === '>' || char === '+' || char === '~') {
      tokens.push({ kind: 'combinator', text: char });
    } else if (char === ',') {
      tokens.push({ kind: 'comma', text: ',' });
    } else if (char === '\\') {
      end = escapeEnd(source, index);
      tokens.push({ kind: 'escape', text: source.slice(index, end) });
    } else if (char === '"' || char === "'") {
      end = stringEnd(source, index);
      tokens.push({ kind: 'string', text: source.slice(index, end) });
    } else if (char === '(' || char === '[' || char === ')' || char === ']') {
      end = groupEnd(source, index);
      tokens.push({ kind: 'group', text: source.slice(index, end) });
    } else {
      while (end < source.length && !SPECIAL.test(source[end]!)) end += 1;
      tokens.push({ kind: 'text', text: source.slice(index, end) });
    }
    index = end;
  }
  return tokens;
}

/** The source text of `tokens` without leading and trailing whitespace tokens. */
function trimmedText(tokens: readonly SelectorToken[]): string {
  let start = 0;
  let end = tokens.length;
  while (start < end && tokens[start]!.kind === 'whitespace') start += 1;
  while (end > start && tokens[end - 1]!.kind === 'whitespace') end -= 1;
  return tokens.slice(start, end).map((token) => token.text).join('');
}

/**
 * One part of a `>>` chain: the engine that reads it, the text that engine
 * reads, and whether it is the part the chain captures (`*css=article`).
 */
export interface SelectorPart {
  readonly engine: string;
  readonly body: string;
  readonly capture: boolean;
}

/** An engine prefix as Playwright's selector grammar reads it, with the capture marker `*` before the engine name. */
const ENGINE_PREFIX = /^(\*?)([a-zA-Z_0-9-]+)\s*=/;

/**
 * A chain part as Playwright reads it: a prefix names the engine and may
 * mark the capture, a path is XPath, the rest CSS. A `*` not followed by an
 * engine prefix is CSS's universal selector.
 */
function selectorPart(text: string): SelectorPart {
  const prefix = ENGINE_PREFIX.exec(text);
  if (prefix !== null) return { engine: prefix[2]!, body: text.slice(prefix[0].length), capture: prefix[1] === '*' };
  return { engine: /^\(*(\/|\.\.)/.test(text) ? 'xpath' : 'css', body: text, capture: false };
}

/**
 * The parts of a `>>` chain, each resolved inside the elements the one before
 * it matched; a `>>` that is escaped, quoted, or inside brackets belongs to
 * its part.
 */
export function chainParts(selector: string): SelectorPart[] {
  const parts: SelectorPart[] = [];
  let current: SelectorToken[] = [];
  for (const token of tokenizeSelector(selector)) {
    if (token.kind === 'chain') {
      parts.push(selectorPart(trimmedText(current)));
      current = [];
    } else current.push(token);
  }
  parts.push(selectorPart(trimmedText(current)));
  return parts;
}

/** The pseudo-classes whose arguments are selectors, by the name the page matches each under: `:where()` reads as `:is()`. */
const NESTED = /:(is|where|not|has)$/i;

/**
 * The selectors a pseudo-class takes, from its parenthesized group; undefined
 * for one the page leaves to the browser: an argument that starts at a
 * sibling (`:has(+ p)`), whose scope the chain does not search, or a group
 * with no closing parenthesis. A `:has()` argument that starts with `>`
 * starts at a `:scope` compound.
 */
function nestedChains(name: CssNested['name'], group: string): CssStep[][] | undefined {
  if (!group.endsWith(')') || group.length < 2) return undefined;
  const chains: CssStep[][] = [];
  let current: SelectorToken[] = [];
  const tokens = tokenizeSelector(group.slice(1, -1));
  for (const token of [...tokens, { kind: 'comma', text: ',' } as const]) {
    if (token.kind !== 'comma') {
      current.push(token);
      continue;
    }
    const leading = current.find((each) => each.kind !== 'whitespace');
    if (leading?.kind === 'combinator' && (name !== 'has' || leading.text !== '>')) return undefined;
    const [chain] = cssChains(`${leading?.kind === 'combinator' ? ':scope ' : ''}${current.map((each) => each.text).join('')}`);
    if (chain === undefined || chain.length === 0) return undefined;
    chains.push(chain);
    current = [];
  }
  return chains;
}

/**
 * A CSS selector list as complex selectors, each its compounds in order with
 * the combinator before each one. Escapes, strings, and groups stay inside
 * their compound, so each compound is source text the browser's `matches`
 * reads as written. A compound with `:is()`, `:where()`, `:not()`, or
 * `:has()` also carries their selectors apart from the rest of it
 * (`CssStep`), for the page to match them through shadow roots.
 */
export function cssChains(selector: string): CssStep[][] {
  const chains: CssStep[][] = [[]];
  let compound = '';
  let plain = '';
  let nested: CssNested[] = [];
  let combinator: CssCombinator | null = null;
  let previous: SelectorToken | undefined;
  const flush = (): void => {
    if (compound === '') return;
    const chain = chains[chains.length - 1]!;
    const joined = { compound, combinator: chain.length === 0 ? null : (combinator ?? ' ') };
    chain.push(nested.length === 0 ? joined : { ...joined, plain: plain === '' ? '*' : plain, nested });
    compound = '';
    plain = '';
    nested = [];
    combinator = null;
  };
  for (const token of tokenizeSelector(selector)) {
    switch (token.kind) {
      case 'whitespace':
        flush();
        break;
      case 'combinator':
        flush();
        combinator = token.text;
        break;
      case 'comma':
        flush();
        chains.push([]);
        combinator = null;
        break;
      default: {
        compound += token.text;
        const name = token.kind === 'group' && token.text.startsWith('(') && previous?.kind === 'text' ? NESTED.exec(previous.text)?.[1]?.toLowerCase() : undefined;
        const kind = name === 'where' ? 'is' : (name as CssNested['name'] | undefined);
        const inner = kind === undefined ? undefined : nestedChains(kind, token.text);
        if (kind === undefined || inner === undefined) {
          plain += token.text;
        } else {
          plain = plain.slice(0, plain.length - name!.length - 1);
          nested.push({ name: kind, chains: inner });
        }
      }
    }
    previous = token;
  }
  flush();
  return chains;
}
