/** Compile-time assertions for `browser.evaluateOn`: a locator first, JSON in and out. */
import type { Locator } from 'e2e';
import type { Browser } from '../../src/index.ts';

declare const browser: Browser;
declare const nav: Locator;

const position: Promise<string> = browser.evaluateOn(nav, (el) => getComputedStyle(el).position);
const width: Promise<number> = browser.evaluateOn(nav, (el, extra: number) => (el as HTMLElement).offsetWidth + extra, 10);
void position;
void width;
void browser.evaluateOn<string>(nav, 'el => el.id');

// @ts-expect-error the target is a locator, not a selector.
void browser.evaluateOn('nav', (el) => el.id);
// @ts-expect-error the result must be JSON-safe.
void browser.evaluateOn(nav, (el) => el);
// @ts-expect-error the argument must be JSON-safe.
void browser.evaluateOn(nav, (_el, arg: Date) => arg.getTime(), new Date());
// @ts-expect-error a function that takes an argument needs one.
void browser.evaluateOn(nav, (_el, arg: { a: number }) => arg.a);

