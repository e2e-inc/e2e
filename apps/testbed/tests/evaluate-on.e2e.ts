import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content, failure } from './helpers.ts';

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
