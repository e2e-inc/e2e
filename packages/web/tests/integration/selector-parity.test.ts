/**
 * CSS and XPath selectors on the BiDi driver match what Playwright 1.64.1
 * matches: each `>>` part is evaluated inside every element the part before
 * it matched, with CSS combinators stopping at that element and a leading
 * `/` in XPath read from it, CSS pierces open shadow roots, and a deep
 * descendant selector costs work linear in the DOM. The expected counts
 * were recorded from `page.locator(selector).count()` on Playwright 1.64.1.
 * Two readings of `:scope` differ, pinned with both counts (`LIMITS`): here
 * it never reaches the scope element's siblings, and inside a pseudo-class
 * it still limits a compound before the last to the scope element.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LocatorExpression } from '@e2e-dev/core/engine';
import { BidiConnection } from '../../src/driver/connection.ts';
import { readerCall } from '../../src/in-page/readers.ts';
import { openBidiPage, type BidiPage } from '../helpers/bidi-page.ts';
import { selectElements } from '../helpers/select-chain.ts';
import { bySelector, startWebSession } from '../helpers/web-session.ts';

const SHADOW = `<p class="x"><div id="host"></div></p><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<section class="in"><span class="inner">S</span><button>Shadow</button></section>';</script>`;

/** A section whose button and tag are in its open shadow root, beside a section and an article with none. */
const SHADOW_HOSTS = `<section id="host"></section><section id="plain"><p>None</p></section><article><i>x</i></article>
<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<div><button>Save</button><span class="tag">T</span></div>';</script>`;

/** Pages, and for each, selectors with the number of elements Playwright 1.64.1 matches. */
const CASES: readonly (readonly [string, Readonly<Record<string, number>>])[] = [
  ['<main class="card"><article><button>X</button></article></main>', {
    'article >> main button': 0,
    'article >> .card > article > button': 0,
    'article >> article button': 0,
    'article >> button': 1,
    'main >> article button': 1,
    'main >> article > button': 1,
    'main >> main article': 0,
    'article >> :scope > button': 1,
  }],
  ['<ul><li class="a">1</li><li class="b">2</li></ul><ul><li class="c">3</li></ul>', {
    'ul >> li + li': 1,
    'li.a >> li': 0,
    'ul >> .a ~ .b': 1,
    'ul >> li ~ li': 1,
    'body >> ul + ul li': 1,
    'ul + ul >> li': 1,
  }],
  ['<section><button>In</button></section><button>Out</button>', {
    'css=section >> xpath=//button': 1,
    'section >> //button': 1,
    'section >> xpath=.//button': 1,
    'section >> xpath=/button': 1,
    'section >> (//button)': 2,
    'xpath=//section >> button': 1,
    '//button': 2,
    'section >> xpath=..': 1,
    'section >> xpath=//section': 0,
  }],
  // A selector inside a pseudo-class crosses a shadow root as a descendant combinator does.
  [SHADOW_HOSTS, {
    'section:has(button)': 1,
    ':is(section button)': 1,
    'section:not(:has(button))': 1,
    '#host button': 1,
    'section:has(> div)': 1,
    'section:has(div > button)': 1,
    ':where(#host .tag)': 1,
    'section:is(:has(.tag), .nope)': 1,
    'button:not(section button)': 0,
    'section:has(button):not(#plain)': 1,
    'body :is(div, p)': 2,
    'section:not(:has(p))': 1,
    'section:has(button) >> span': 1,
    'section >> :is(div button)': 1,
    '#host >> :has(> button)': 1,
    'section:has(p, button)': 2,
    ':not(:has(*))': 6,
    'section:has(+ section)': 1,
  }],
  [SHADOW, {
    'p .inner': 0,
    '#host span': 1,
    '#host >> span': 1,
    '#host >> section > span': 1,
    'div .in span, button': 2,
    '.in >> span': 1,
    'section ~ button': 0,
    'span ~ button': 1,
    '#host >> xpath=//span': 0,
    'span >> xpath=..': 1,
    '#host >> :scope': 1,
    '#host >> :scope >> span': 1,
    '.in >> :scope': 1,
    '.in >> :scope >> button': 1,
  }],
  ['<main><article><p><button>A</button></p><button>B</button></article></main>', {
    ':scope > body': 1,
    ':scope main': 1,
    'article >> :scope button': 2,
    'main >> :scope > article > button': 1,
    'article >> p > button, :scope > button': 2,
    'main >> article >> p button': 1,
    'xpath=//article >> xpath=./button': 1,
    'article >> xpath=//p >> button': 1,
    'article >> xpath=//button': 2,
  }],
  ['<div><div><div><span>x</span></div></div></div>', {
    'div >> div div span': 1,
    'div >> div > div > span': 1,
    'div div': 2,
    'div >> div': 2,
    'div >> div >> div': 1,
    'div div >> div span': 1,
  }],
  ['<article><button>X</button></article>', {
    ':scope': 1,
    'article >> :scope': 1,
    'article >> :scope >> button': 1,
    'article >> :scope >> :scope': 1,
    'article >> :scope.x': 0,
    'article >> article:scope': 1,
    'article >> :scope:not(article)': 0,
    'article >> :scope:has(button)': 1,
    'article >> :scope, button': 2,
    'article >> :is(:scope, button)': 2,
    'article >> :not(:scope)': 1,
    'article >> :scope :scope': 0,
    'html >> :scope': 1,
    'button >> :scope': 1,
  }],
  ['<html class="x"><body><article class="x"><button class="x">X</button></article><article><button>Y</button></article></body></html>', {
    ':scope.x': 1,
    'article >> :scope': 2,
    'article >> :scope.x': 1,
    'article >> .x:scope': 1,
    'article >> :scope:not(.x)': 1,
    'article >> :scope >> .x': 1,
    'article >> :scope, .x': 3,
    'body >> :scope > article >> :scope': 2,
  }],
];

/** The page of `LIMITS`: a scope `div` with a `p` in it, and a `p` after it. */
const SIBLINGS = '<div><p><button>A</button></p><button>B</button></div><p><button>C</button></p>';

/**
 * Where the driver answers differently from Playwright 1.64.1 on `SIBLINGS`,
 * by reason: selectors with the count Playwright matches, then the count
 * the driver does. Playwright roots a selector with a top-level `:scope` at
 * the scope element's parent, which puts its siblings in reach; here every
 * combinator stops at the scope element. And Playwright takes only a
 * top-level `:scope` for one, so the scope element matches no other
 * compound and a compound that names `:scope` inside a pseudo-class matches
 * the elements under it; here such a compound before the last is matched
 * against the scope element alone.
 */
const LIMITS: readonly { readonly reason: string; readonly rows: Readonly<Record<string, readonly [playwright: number, driver: number]>> }[] = [
  {
    reason: 'a :scope compound never reaches the scope element\'s siblings',
    rows: {
      'div >> :scope + p': [1, 0],
      'div >> :scope ~ p': [1, 0],
      'p >> div + :scope': [1, 0],
      'p >> div ~ :scope': [1, 0],
      'div >> :scope ~ p button': [1, 0],
      'div >> :is(:scope + p)': [1, 0],
    },
  },
  {
    reason: 'a compound before the last that names :scope inside a pseudo-class is matched against the scope element alone',
    rows: {
      'div >> :is(:scope) button': [0, 2],
      'div >> :is(:scope, p) button': [1, 2],
      'div >> :not(:scope) > button': [1, 0],
      'div >> p:not(:scope) > button': [1, 0],
      'div >> :not(:scope > p) > button': [0, 1],
    },
  },
];

describe('selectors as Playwright reads them', () => {
  let page: BidiPage;

  beforeAll(async () => {
    page = await openBidiPage();
  });

  afterAll(async () => {
    await page?.close();
  });

  /** How many elements `selector` matches on the driver. */
  const count = async (selector: string): Promise<number> => (await selectElements(page, selector)).length;

  it.each(CASES.map(([html, expected], index) => [index, html, expected] as const))('matches page %i as Playwright does', async (_index, html, expected) => {
    await page.setContent(html);
    const actual: Record<string, number> = {};
    for (const selector of Object.keys(expected)) actual[selector] = await count(selector);
    expect(actual).toEqual(expected);
  });

  it.each(LIMITS)('answers differently from Playwright: $reason', async ({ rows }) => {
    await page.setContent(SIBLINGS);
    const actual: Record<string, number> = {};
    for (const selector of Object.keys(rows)) actual[selector] = await count(selector);
    expect(actual).toEqual(Object.fromEntries(Object.entries(rows).map(([selector, [, driver]]) => [selector, driver])));
    expect(Object.values(rows).filter(([playwright, driver]) => playwright === driver)).toEqual([]);
  });

  it('matches a scope element created in a frame\'s document and moved into the page', async () => {
    await page.setContent('<iframe></iframe><main></main>');
    await page.evaluate(() => {
      const made = document.querySelector('iframe')!.contentDocument!.createElement('article');
      made.append(document.createElement('button'));
      document.querySelector('main')!.append(made);
    });
    expect({ scope: await count('article >> :scope'), inside: await count('article >> :scope >> button'), under: await count('main >> :scope > article') }).toEqual({ scope: 1, inside: 1, under: 1 });
  });

  it('matches a deep descendant selector in work linear in the DOM', async () => {
    await page.setContent(`${'<div>'.repeat(24)}<span>x</span>${'</div>'.repeat(24)}`);
    // The chain's work is the compounds it asks elements to match: counted, whatever the machine's speed.
    const elements = await page.evaluate(() => {
      const counted = window as unknown as { matchCalls: number };
      const matches = Element.prototype.matches;
      counted.matchCalls = 0;
      Element.prototype.matches = function (this: Element, selectors: string): boolean {
        counted.matchCalls += 1;
        return matches.call(this, selectors);
      } as typeof matches;
      return document.querySelectorAll('*').length;
    });
    /** How many elements `selector` matches, and how many compound matches finding them took. */
    const worked = async (selector: string): Promise<{ matches: number; calls: number }> => {
      await page.evaluate(() => void ((window as unknown as { matchCalls: number }).matchCalls = 0));
      const matches = await count(selector);
      return { matches, calls: Number(await page.evaluate(() => (window as unknown as { matchCalls: number }).matchCalls)) };
    };
    // 13 compounds: one walk up the tree per compound at most, where a matcher that backtracks takes millions.
    const linear = 13 * Number(elements);
    const missing = await worked(`section ${'div '.repeat(11)}span`);
    expect(missing.matches).toBe(0);
    expect(missing.calls).toBeGreaterThan(0);
    expect(missing.calls).toBeLessThanOrEqual(linear);
    const found = await worked(`${'div '.repeat(12)}span`);
    expect(found.matches).toBe(1);
    expect(found.calls).toBeLessThanOrEqual(linear);
  });

  it('resolves a frame chain in three calls per frame, none in the frame\'s own world, and reads the matches in one', async () => {
    const inner = '<section><iframe srcdoc="<button>Deep</button>"></iframe></section>';
    const frames = ['#outer', 'section >> xpath=//iframe'];
    const session = await startWebSession();
    try {
      await session.setContent(`<iframe id="outer" srcdoc="${inner.replaceAll('"', '&quot;')}"></iframe>`);
      await session.waitForFrames();
      const calls = vi.spyOn(BidiConnection.prototype, 'send');
      const found = await session.locate(frames.reduceRight<LocatorExpression>((source, selector) => ({ kind: 'frame', selector, source }), bySelector('button')));
      expect(found.map((node) => ({ name: node.name, framePath: node.framePath }))).toEqual([{ name: 'Deep', framePath: frames }]);
      const readers = new Map([[readerCall('selectFrame'), 'selectFrame reader'], [readerCall('locate'), 'locate reader']]);
      const sent = calls.mock.calls.map(([method, params]) => {
        if (method !== 'script.callFunction') return method;
        const { functionDeclaration, target } = params as { functionDeclaration: string; target: { sandbox?: string } };
        return readers.get(functionDeclaration) ?? `page function in ${target.sandbox ?? 'the page\'s world'}`;
      });
      const perFrame = ['selectFrame reader', 'page function in e2e-frames', 'script.getRealms'];
      expect(sent).toEqual([...perFrame, ...perFrame, 'locate reader']);
    } finally {
      vi.restoreAllMocks();
      await session.close();
    }
  });
});
