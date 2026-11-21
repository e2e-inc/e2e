import type { Page } from 'playwright-core';

/**
 * Reads how many client objects Playwright keeps on `page`'s connection. A
 * handle stays there until it is disposed, so a test counts leaked handles
 * with it. It first checks that one undisposed handle adds one object, so a
 * Playwright that stops keeping handles there fails the test instead of
 * letting it count nothing.
 */
export async function connectionObjectCount(page: Page): Promise<() => number> {
  const connection: unknown = Reflect.get(page, '_connection');
  const objects: unknown = typeof connection === 'object' && connection !== null ? Reflect.get(connection, '_objects') : undefined;
  if (!(objects instanceof Map)) throw new Error('playwright-core no longer keeps its objects in _connection._objects');
  const before = objects.size;
  const handle = await page.evaluateHandle('1');
  const kept = objects.size - before;
  await handle.dispose();
  if (kept !== 1) throw new Error(`an undisposed handle added ${kept} objects to _connection._objects, not 1`);
  return () => objects.size;
}
