/**
 * The readers' selector chain on its own, in a raw BiDi tab: for tests that
 * pin which elements a selector matches, below the engine.
 */

import { pageParts, unparsedSelector } from '../../src/driver/frames.ts';
import { ElementRef } from '../../src/driver/script.ts';
import { withDom } from '../../src/in-page/dom.ts';
import { selectChain } from '../../src/in-page/select-chain.ts';
import type { BidiPage } from './bidi-page.ts';

/** The elements `selector` matches in the page's document, as a set: their order means nothing. */
export async function selectElements(page: BidiPage, selector: string): Promise<ElementRef[]> {
  const found = await page.evaluate(withDom(selectChain), pageParts(selector));
  if (typeof found === 'string') throw unparsedSelector(selector, found);
  if (!Array.isArray(found)) throw new Error(`selector ${selector} read an unexpected value`);
  return found.filter((each) => each instanceof ElementRef);
}

/** The tag name of each of `elements`, read in the page. */
export async function localNames(page: BidiPage, elements: readonly ElementRef[]): Promise<string[]> {
  return (await page.evaluate((...found: Element[]) => found.map((element) => element.localName), ...elements)) as string[];
}
