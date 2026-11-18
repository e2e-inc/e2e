import { test } from '@e2e-dev/web';
import { expect, type Locator } from 'e2e';
import { content, failure } from './helpers.ts';

/** A page whose `#slow` element answers `slow` with 1, but only after a 300 ms busy wait in the page. */
const slow = content(`<html><p id="slow">Slow</p><script>
  Object.defineProperty(document.getElementById('slow'), 'slow', {
    get() { const start = Date.now(); while (Date.now() - start < 300); return 1; },
  });
</script></html>`);

/** A page that answers for about 300 ms after it loads, then blocks its main thread for about 1.5 s. */
const frozen = content(`<html><p id="frozen" style="color: blue">Frozen</p><script>
  setTimeout(() => { const start = Date.now(); while (Date.now() - start < 1500); }, 300);
</script></html>`);

const page = content(`<html>
  <nav aria-label="Breadcrumbs" style="position: static">a / b</nav>
  <nav aria-label="Main" data-x="1" style="position: sticky; top: 0; --accent: red; --grid: a    b">Home</nav>
  <iframe srcdoc="<aside style='width: 240px'>Side</aside>"></iframe>
  <label>Name <input value="Ada"></label>
  <p id="holder">Holder</p>
  <script>
    document.querySelector('[aria-label="Main"]').config = { mode: 'dark', sizes: [1, 2] };
    document.getElementById('holder').holder = { inner: null };
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

  test('reads an element a label locator matches', async ({ browser, screen }) => {
    await browser.goto(page);
    expect(await browser.evaluateOn(screen.getByLabel('Name'), (el) => (el as HTMLInputElement).value)).toBe('Ada');
  });

  test('refuses a result that is not JSON, naming evaluateOn', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    const error = await failure(() => browser.evaluateOn(main, 'el => el'));
    expect(error).toHaveProperty('code', 'INVALID_ARGUMENT');
    expect(error).toHaveProperty('message', expect.stringMatching(/^evaluateOn result must be JSON-safe/));
  });

  test('refuses an argument that is not JSON', async ({ browser }) => {
    await browser.goto(page);
    const error = await failure(() => browser.evaluateOn(browser.locator('#late'), (el) => el.id, new Map() as never));
    expect(error).toHaveProperty('code', 'INVALID_ARGUMENT');
  });

  test('reads again when the page reloads during a read', async ({ browser }) => {
    await browser.goto(page);
    await browser.evaluate('() => { setTimeout(() => location.reload(), 100); }');
    const read = await browser.evaluateOn(
      browser.locator('#holder'),
      (el) => new Promise<string>((resolve) => setTimeout(() => resolve(el.id), 300)),
    );
    expect(read).toBe('holder');
  });

  test('names itself when the target is not a locator', async ({ browser }) => {
    await browser.goto(page);
    const error = await failure(() => browser.evaluateOn('#x' as never, (el) => el.id));
    expect(error).toHaveProperty('code', 'INVALID_LOCATOR');
    expect(error).toHaveProperty('message', expect.stringContaining('browser.evaluateOn'));
  });
});

test.describe('expect(browser).toHaveCSS', { requires: ['browser'] }, () => {
  test('collapses whitespace in the value, and tests a RegExp against the collapsed value', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(await browser.evaluateOn(main, (el) => getComputedStyle(el).getPropertyValue('--grid'))).toBe('a    b');
    await expect(browser).toHaveCSS(main, '--grid', 'a b');
    await expect(browser).toHaveCSS(main, '--grid', /^a b$/);
    await expect(browser).not.toHaveCSS(main, '--grid', /a {4}b/, { timeout: 300 });
  });

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

  test('matches a string as the whole value, not a part of it', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    const error = await failure(() => expect(browser).toHaveCSS(main, 'position', 'stick', { timeout: 300 }));
    expect(error).toHaveProperty('code', 'ASSERTION_FAILED');
  });

  test('fails on an element that never appears, and on an ambiguous locator', async ({ browser }) => {
    await browser.goto(page);
    const missing = await failure(() => expect(browser).toHaveCSS(browser.locator('#missing'), 'position', 'static', { timeout: 300 }));
    expect(missing).toHaveProperty('code', 'ASSERTION_FAILED');
    expect(missing).toHaveProperty('message', expect.stringContaining('observed: no node'));
    const ambiguous = await failure(() => expect(browser).toHaveCSS(browser.locator('nav'), 'position', 'static', { timeout: 300 }));
    expect(ambiguous).toHaveProperty('code', 'LOCATOR_AMBIGUOUS');
  });

  test('fails a negation on an element that never appears', async ({ browser }) => {
    await browser.goto(page);
    const missing = browser.locator('#missing');
    const error = await failure(() => expect(browser).not.toHaveCSS(missing, 'position', 'static', { timeout: 300 }));
    expect(error).toHaveProperty('code', 'ASSERTION_FAILED');
    expect(error).toHaveProperty('message', expect.stringContaining('observed: no node'));
  });

  test('fails a negation when the page stops answering', async ({ browser }) => {
    await browser.goto(frozen);
    const error = await failure(() =>
      expect(browser).not.toHaveCSS(browser.locator('#frozen'), 'color', 'red', { timeout: 1000 }),
    );
    expect(error).toHaveProperty('code', 'ACTION_FAILED');
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

  test('compares an object and an array the page set as JSON', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    await expect(browser).toHaveJSProperty(main, 'config', { sizes: [1, 2], mode: 'dark' });
    await expect(browser).toHaveJSProperty(main, 'config.sizes', [1, 2]);
    await expect(browser).not.toHaveJSProperty(main, 'config.sizes', [2, 1], { timeout: 300 });
  });

  test('never matches a value that is not JSON, so its negation passes', async ({ browser, screen }) => {
    await browser.goto(page);
    await expect(browser).not.toHaveJSProperty(screen.getByRole('navigation', { name: 'Main' }), 'style', 'x');
  });

  test('walks a path as Playwright does, reading the last key off a string but not stepping through one', async ({ browser, screen }) => {
    await browser.goto(page);
    const name = screen.getByLabel('Name');
    await expect(browser).toHaveJSProperty(name, 'value.length', 3);
    await expect(browser).not.toHaveJSProperty(name, 'value.0.length', 1);
    await expect(browser).toHaveJSProperty(name, 'focus.length', 0);
    await expect(browser).not.toHaveJSProperty(name, 'focus.name.length', 5);
    const error = await failure(() => expect(browser).toHaveJSProperty(name, 'value.0.length', 1, { timeout: 300 }));
    expect(error).toHaveProperty('code', 'ASSERTION_FAILED');
    expect(error).toHaveProperty('message', expect.stringContaining('observed: property value.0.length is undefined'));
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

  test('matches on an element a label locator matches', async ({ browser, screen }) => {
    await browser.goto(page);
    await expect(browser).toHaveJSProperty(screen.getByLabel('Name'), 'value', 'Ada');
  });

  test('refuses a path or an expected value it cannot compare', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    for (const [path, expected] of [
      ['', '1'],
      [1, '1'],
      ['dataset.x', undefined],
      ['dataset.x', new Date()],
    ] as const) {
      const error = await failure(() => expect(browser).toHaveJSProperty(main, path as never, expected as never));
      expect(error).toHaveProperty('code', 'INVALID_ARGUMENT');
    }
  });

  test('refuses an expected value JSON.stringify cannot write, as a rejection', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const expected of [1n, cyclic]) {
      let thrown: unknown;
      let pending: unknown;
      try {
        pending = expect(browser).toHaveJSProperty(main, 'dataset.x', expected as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      const error = await failure(() => pending);
      expect(error).toHaveProperty('code', 'INVALID_ARGUMENT');
    }
  });

  test('fails a sample that outlasts the assertion timeout, even when it would match', async ({ browser }) => {
    await browser.goto(slow);
    const error = await failure(() => expect(browser).toHaveJSProperty(browser.locator('#slow'), 'slow', 1, { timeout: 200 }));
    expect(error).toHaveProperty('code', 'ACTION_FAILED');
  });

  test('fails a negation when the page stops answering', async ({ browser }) => {
    await browser.goto(frozen);
    const error = await failure(() =>
      expect(browser).not.toHaveJSProperty(browser.locator('#frozen'), 'id', 'other', { timeout: 1000 }),
    );
    expect(error).toHaveProperty('code', 'ACTION_FAILED');
  });

  test('compares the expected value as JSON, so -0 matches the 0 the page sends', async ({ browser }) => {
    await browser.goto(page);
    await expect(browser).toHaveJSProperty(browser.locator('#holder'), 'scrollTop', -0);
  });

  test('walks the path the test gave, even when the page replaces String.prototype.split', async ({ browser }) => {
    await browser.goto(page);
    await browser.evaluate("() => { String.prototype.split = function () { return ['id']; }; }");
    await expect(browser).toHaveJSProperty(browser.locator('[data-x]'), 'dataset.x', '1');
  });

  test('reads a path through a null value as undefined, so its negation passes', async ({ browser }) => {
    await browser.goto(page);
    const holder = browser.locator('#holder');
    await expect(browser).not.toHaveJSProperty(holder, 'holder.inner.x', 1);
    const error = await failure(() => expect(browser).toHaveJSProperty(holder, 'holder.inner.x', 1, { timeout: 300 }));
    expect(error).toHaveProperty('code', 'ASSERTION_FAILED');
    expect(error).toHaveProperty('message', expect.stringContaining('observed: property holder.inner.x is undefined'));
  });

  test('reports a route failure the poll ran into, instead of reading it as a value that is not JSON', async ({ browser }) => {
    await browser.route('**/latched', (route) => route.fulfill({ status: 0 }));
    await browser.goto(page);
    await browser.evaluate("() => { setTimeout(() => fetch('/latched').catch(() => undefined), 50); }");
    const error = await failure(() => expect(browser).toHaveJSProperty(browser.locator('#late'), 'id', 'late'));
    expect(error).toHaveProperty('code', 'INVALID_ARGUMENT');
  });
});

test.describe('expect(browser) locator matchers', { requires: ['browser'] }, () => {
  test('refuse a target that is not a locator, naming the matcher', async ({ browser }) => {
    await browser.goto(page);
    const target = '#x' as never;
    const calls = [
      ['expect.toHaveClass', () => expect(browser).toHaveClass(target, 'x')],
      ['expect.not.toHaveClass', () => expect(browser).not.toHaveClass(target, 'x')],
      ['expect.toHaveCSS', () => expect(browser).toHaveCSS(target, 'position', 'x')],
      ['expect.not.toHaveCSS', () => expect(browser).not.toHaveCSS(target, 'position', 'x')],
      ['expect.toHaveJSProperty', () => expect(browser).toHaveJSProperty(target, 'id', 'x')],
      ['expect.not.toHaveJSProperty', () => expect(browser).not.toHaveJSProperty(target, 'id', 'x')],
    ] as const;
    for (const [api, call] of calls) {
      const error = await failure(call);
      expect(error).toHaveProperty('code', 'INVALID_LOCATOR');
      expect(error).toHaveProperty('message', `${api} requires an e2e locator`);
    }
  });

  test('refuse a look-alike with count() once it reports a match', async ({ browser }) => {
    await browser.goto(page);
    const target = { count: async () => 1 } as never;
    for (const [api, call] of [
      ['expect.toHaveCSS', () => expect(browser).toHaveCSS(target, 'position', 'x')],
      ['expect.toHaveJSProperty', () => expect(browser).toHaveJSProperty(target, 'id', 'x')],
    ] as const) {
      const error = await failure(call);
      expect(error).toHaveProperty('code', 'INVALID_LOCATOR');
      expect(error).toHaveProperty('message', `${api} requires an e2e locator`);
    }
  });
});

test.describe('a locator from an earlier attempt', { serial: true, requires: ['browser'] }, () => {
  let earlier: Locator | undefined;
  let missing: Locator | undefined;

  test('keeps a locator for the next test', async ({ browser, screen }) => {
    await browser.goto(page);
    earlier = screen.getByRole('navigation', { name: 'Main' });
    missing = browser.locator('#never');
    await expect(browser).toHaveCSS(earlier, 'position', 'sticky');
  });

  test('is refused, naming the call', async ({ browser }) => {
    await browser.goto(page);
    const target = earlier!;
    const calls = [
      ['browser.evaluateOn', () => browser.evaluateOn(target, (el) => el.id)],
      ['expect.toHaveCSS', () => expect(browser).toHaveCSS(target, 'position', 'sticky')],
      ['expect.toHaveJSProperty', () => expect(browser).toHaveJSProperty(target, 'dataset.x', '1')],
    ] as const;
    for (const [api, call] of calls) {
      const error = await failure(call);
      expect(error).toHaveProperty('code', 'INVALID_LOCATOR');
      expect(error).toHaveProperty('message', expect.stringContaining(`${api} requires a locator made by this screen`));
    }
  });

  test('polls like any target while it matches nothing, so a matcher fails observing no node', async ({ browser }) => {
    await browser.goto(page);
    const target = missing!;
    for (const call of [
      () => expect(browser).toHaveCSS(target, 'position', 'sticky', { timeout: 300 }),
      () => expect(browser).toHaveJSProperty(target, 'id', 'never', { timeout: 300 }),
    ]) {
      const error = await failure(call);
      expect(error).toHaveProperty('code', 'ASSERTION_FAILED');
      expect(error).toHaveProperty('message', expect.stringContaining('observed: no node'));
    }
  });
});
