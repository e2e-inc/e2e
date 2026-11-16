import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, failure } from './helpers.ts';

/** A page whose `#slow` element answers `slow` only after a 600 ms busy wait in the page. */
const slow = content(`<html><p id="slow">Slow</p><script>
  Object.defineProperty(document.getElementById('slow'), 'slow', {
    get() { const start = Date.now(); while (Date.now() - start < 600); return 1; },
  });
</script></html>`);

const page = content(`<html>
  <nav aria-label="Breadcrumbs" style="position: static">a / b</nav>
  <nav aria-label="Main" data-x="1" style="position: sticky; top: 0; --accent: red">Home</nav>
  <iframe srcdoc="<aside style='width: 240px'>Side</aside>"></iframe>
  <script>
    setTimeout(() => {
      const late = document.createElement('p');
      late.id = 'late';
      late.textContent = 'Late';
      document.body.append(late);
    }, 300);
  </script>
</html>`);

test.describe('browser.evaluateOn', { requires: ['browser'] }, () => {
  test('reads the element the locator matches, not the first one a selector finds', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(await browser.evaluateOn(main, (el) => getComputedStyle(el).position)).toBe('sticky');
    expect(await browser.evaluateOn(main, 'el => el.getAttribute("aria-label")')).toBe('Main');
  });

  test('reads an element inside a frame', async ({ browser }) => {
    await browser.goto(page);
    const aside = browser.frameLocator('iframe').locator('aside');
    expect(await browser.evaluateOn(aside, (el) => (el as HTMLElement).offsetWidth)).toBe(240);
  });

  test('passes a JSON argument after the element', async ({ browser }) => {
    await browser.goto(page);
    const aside = browser.frameLocator('iframe').locator('aside');
    const read = await browser.evaluateOn(
      aside,
      (el, extra: { add: number; label: string }) => ({ width: (el as HTMLElement).offsetWidth + extra.add, label: extra.label }),
      { add: 10, label: 'side' },
    );
    expect(read).toEqual({ width: 250, label: 'side' });
  });

  test('rejects a locator that matches two elements', async ({ browser }) => {
    await browser.goto(page);
    const error = await failure(() => browser.evaluateOn(browser.locator('nav'), (el) => el.id));
    expect(error).toHaveProperty('code', 'LOCATOR_AMBIGUOUS');
  });

  test('waits for an element that appears later', async ({ browser }) => {
    await browser.goto(page);
    expect(await browser.evaluateOn(browser.locator('#late'), (el) => el.textContent)).toBe('Late');
  });
});

test.describe('expect(browser).toHaveCSS', { requires: ['browser'] }, () => {
  test('matches a computed value, a custom property, and its negation', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    await expect(browser).toHaveCSS(main, 'position', 'sticky');
    await expect(browser).toHaveCSS(main, '--accent', /red/);
    await expect(browser).not.toHaveCSS(main, 'position', 'static');
    await expect(browser).toHaveCSS(browser.frameLocator('iframe').locator('aside'), 'width', '240px');
  });

  test('waits for an element that appears later', async ({ browser }) => {
    await browser.goto(page);
    await expect(browser).toHaveCSS(browser.locator('#late'), 'display', 'block');
  });

  test('fails with the value it observed', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    const error = await failure(() => expect(browser).toHaveCSS(main, 'position', 'fixed', { timeout: 300 }));
    expect(error).toHaveProperty('code', 'ASSERTION_FAILED');
    expect(error).toHaveProperty('message', expect.stringContaining('observed: css position "sticky"'));
  });

  test('fails on an element that never appears, and on an ambiguous locator', async ({ browser }) => {
    await browser.goto(page);
    const missing = await failure(() => expect(browser).toHaveCSS(browser.locator('#missing'), 'position', 'static', { timeout: 300 }));
    expect(missing).toHaveProperty('code', 'ASSERTION_FAILED');
    expect(missing).toHaveProperty('message', expect.stringContaining('observed: no node'));
    const ambiguous = await failure(() => expect(browser).toHaveCSS(browser.locator('nav'), 'position', 'static', { timeout: 300 }));
    expect(ambiguous).toHaveProperty('code', 'LOCATOR_AMBIGUOUS');
  });

  test('refuses an empty property name', async ({ browser, screen }) => {
    await browser.goto(page);
    const error = await failure(() => expect(browser).toHaveCSS(screen.getByRole('navigation', { name: 'Main' }), '', 'sticky'));
    expect(error).toHaveProperty('code', 'INVALID_ARGUMENT');
  });
});

test.describe('expect(browser).toHaveJSProperty', { requires: ['browser'] }, () => {
  test('matches a dotted path and a number', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    await expect(browser).toHaveJSProperty(main, 'dataset.x', '1');
    await expect(browser).toHaveJSProperty(main, 'style.position', 'sticky');
    await expect(browser).toHaveJSProperty(browser.frameLocator('iframe').locator('aside'), 'offsetWidth', 240);
    await expect(browser).not.toHaveJSProperty(main, 'dataset.missing.deeper', '1');
  });

  test('fails with the value it observed, or that it is not JSON', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    const wrong = await failure(() => expect(browser).toHaveJSProperty(main, 'dataset.x', 2, { timeout: 300 }));
    expect(wrong).toHaveProperty('code', 'ASSERTION_FAILED');
    expect(wrong).toHaveProperty('message', expect.stringContaining('observed: property dataset.x "1"'));
    const opaque = await failure(() => expect(browser).toHaveJSProperty(main, 'style', 'sticky', { timeout: 300 }));
    expect(opaque).toHaveProperty('code', 'ASSERTION_FAILED');
    expect(opaque).toHaveProperty('message', expect.stringContaining('observed: property style is not JSON'));
  });

  test('ends a slow sample at the assertion timeout', async ({ browser }) => {
    await browser.goto(slow);
    const error = await failure(() => expect(browser).toHaveJSProperty(browser.locator('#slow'), 'slow', 1, { timeout: 200 }));
    expect(error).toHaveProperty('code', 'ASSERTION_FAILED');
  });

  test('reports a route failure the poll ran into, instead of reading it as a value that is not JSON', async ({ browser }) => {
    await browser.route('**/latched', (route) => route.fulfill({ status: 0 }));
    await browser.goto(page);
    await browser.evaluate("() => { setTimeout(() => fetch('/latched').catch(() => undefined), 50); }");
    const error = await failure(() => expect(browser).toHaveJSProperty(browser.locator('#late'), 'id', 'late'));
    expect(error).toHaveProperty('code', 'INVALID_ARGUMENT');
  });
});
