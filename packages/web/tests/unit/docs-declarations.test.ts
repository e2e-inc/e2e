/**
 * The type declarations `docs/reference/web.mdx` prints are the ones the
 * package exports: each interface the page shows has the members, in the
 * order and with the types, of the interface of that name in the source.
 * Their JSDoc may be shorter on the page.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DOCS = readFileSync(new URL('../../../../docs/reference/web.mdx', import.meta.url), 'utf8');

const SOURCES = ['../../src/options.ts', '../../src/fixture/types.ts', '../../src/attach.ts']
  .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
  .join('\n');

/** The members of `interface name` in `text`, comments and blank lines left out; undefined when it declares none. */
function membersOf(text: string, name: string): string[] | undefined {
  const start = new RegExp(`^(?:export )?interface ${name}\\b[^{]*\\{`, 'm').exec(text);
  if (start === null) return undefined;
  let depth = 1;
  let end = start.index + start[0].length;
  for (; depth > 0; end += 1) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0;
  return text
    .slice(start.index + start[0].length, end - 1)
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

const SHOWN = [...DOCS.matchAll(/^(?:export )?interface (\w+)\b/gm)].map((match) => match[1]!).filter((name) => membersOf(SOURCES, name) !== undefined);

describe('the declarations the web reference prints', () => {
  it('shows interfaces the package declares', () => {
    expect(SHOWN).toEqual(expect.arrayContaining(['WebOptions', 'Browser', 'BrowserTab', 'WebRoute', 'WebResponse']));
  });

  it.each(SHOWN)('prints %s with the members the source declares', (name) => {
    expect(membersOf(DOCS, name)).toEqual(membersOf(SOURCES, name));
  });
});
