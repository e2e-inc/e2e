import { test } from '@e2e-dev/web';
import { expect, type Locator } from 'e2e';
import { content, failure } from './helpers.ts';

/** A page whose `#slow` element answers `slow` with 1, but only after a 300 ms busy wait in the page. */
const slow = content(`<html><p id="slow">Slow</p><script>
  Object.defineProperty(document.getElementById('slow'), 'slow', {
    get() { const start = Date.now(); while (Date.now() - start < 300); return 1; },
  });
</script></html>`);

/**
 * A page whose `#r` answers `state` with a promise that never settles, and
 * reloads 200 ms later; after the reload it answers `done`. A read of
 * `state` is still running when the page navigates.
 */
const reloading = content(`<html><p id="r">Reloading</p><script>
  const r = document.getElementById('r');
  if (sessionStorage.getItem('reloaded') === null) {
    r.state = new Promise(() => undefined);
    setTimeout(() => { sessionStorage.setItem('reloaded', 'yes'); location.reload(); }, 200);
  } else {
    r.state = 'done';
  }
</script></html>`);

/**
 * A page whose `burst()` replaces `#flip` with a new element on every task
 * for 300 ms, so an element matched during it soon leaves its document, and
 * then leaves the last one in place.
 */
const flipping = content(`<html><p id="flip">Flip</p><script>
  window.burst = () => {
    const until = Date.now() + 300;
    const flip = () => {
      const next = document.createElement('p');
      next.id = 'flip';
      next.textContent = 'Flip';
      document.getElementById('flip').replaceWith(next);
      if (Date.now() < until) setTimeout(flip, 0);
    };
    flip();
  };
</script></html>`);

/** A page whose `#gone` (class `a`, blue) is removed 300 ms after load. */
const vanishing = content(`<html><p id="gone" class="a" style="color: blue">Gone</p><script>
  setTimeout(() => document.getElementById('gone').remove(), 300);
</script></html>`);

/** A page whose `#late` appears 600 ms after load as class `pending` and becomes `error` 300 ms later. */
const lateThenError = content(`<html><body><script>
  setTimeout(() => {
    const late = document.createElement('p');
    late.id = 'late';
    late.className = 'pending';
    late.textContent = 'Late';
    document.body.append(late);
    setTimeout(() => { late.className = 'error'; }, 300);
  }, 600);
</script></body></html>`);

/** A page whose `#stuck` exists, and whose main thread blocks for 3 s from 100 ms after load. */
const stuckEarly = content(`<html><p id="stuck" class="a">Stuck</p><script>
  setTimeout(() => { const start = Date.now(); while (Date.now() - start < 3000); }, 100);
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
  <p id="spaced" class="  a   b ">Spaced</p>
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

  test('fails, and never runs the function again, when the page navigates while it runs', async ({ browser }) => {
    await browser.goto(page);
    const error = await failure(() => browser.evaluateOn(browser.locator('#holder'), () => {
      sessionStorage.setItem('runs', String(Number(sessionStorage.getItem('runs') ?? '0') + 1));
      location.reload();
      return new Promise<never>(() => undefined);
    }));
    expect(error).toHaveProperty('code', 'ENGINE_FAILURE');
    expect(error).toHaveProperty('message', expect.stringContaining('navigation'));
    await expect(browser).toHaveJSProperty(browser.locator('#holder'), 'ownerDocument.defaultView.sessionStorage.runs', '1');
  });

  test('runs on an element still in its document, when the page replaces it after the match', async ({ browser }) => {
    await browser.goto(flipping);
    for (let run = 0; run < 10; run += 1) {
      await browser.evaluate('() => window.burst()');
      expect(await browser.evaluateOn(browser.locator('#flip'), (el) => el.isConnected)).toBe(true);
    }
  });

  test('names itself when the target is not a locator', async ({ browser }) => {
    await browser.goto(page);
    const error = await failure(() => browser.evaluateOn('#x' as never, (el) => el.id));
    expect(error).toHaveProperty('code', 'INVALID_LOCATOR');
    expect(error).toHaveProperty('message', expect.stringContaining('browser.evaluateOn'));
  });
});

test.describe('expect(browser).toHaveCSS', { requires: ['browser'] }, () => {
  test('compares the raw value, whitespace included, as Playwright does', async ({ browser, screen }) => {
    await browser.goto(page);
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(await browser.evaluateOn(main, (el) => getComputedStyle(el).getPropertyValue('--grid'))).toBe('a    b');
    await expect(browser).toHaveCSS(main, '--grid', 'a    b');
    await expect(browser).toHaveCSS(main, '--grid', /^a {4}b$/);
    await expect(browser).not.toHaveCSS(main, '--grid', 'a b', { timeout: 300 });
  });

  test('reads again when the page navigates during its read', async ({ browser }) => {
    await browser.goto(reloading);
    await expect(browser).toHaveJSProperty(browser.locator('#r'), 'state', 'done');
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
  test('fail observing no node when the node leaves after a read', async ({ browser }) => {
    await browser.goto(vanishing);
    const gone = browser.locator('#gone');
    for (const call of [
      () => expect(browser).toHaveClass(gone, 'b', { timeout: 1000 }),
      () => expect(browser).toHaveCSS(gone, 'color', 'rgb(255, 0, 0)', { timeout: 1000 }),
    ]) {
      const error = await failure(call);
      expect(error).toHaveProperty('code', 'ASSERTION_FAILED');
      expect(error).toHaveProperty('message', expect.stringContaining('observed: no node'));
    }
  });

  test('fail a negation that holds only until the node arrives and matches', async ({ browser }) => {
    for (const call of [
      () => expect(browser).not.toHaveClass(browser.locator('#late'), 'error', { timeout: 2500 }),
      () => expect(browser).not.toHaveJSProperty(browser.locator('#late'), 'className', 'error', { timeout: 2500 }),
    ]) {
      await browser.goto(lateThenError);
      const error = await failure(call);
      expect(error).toHaveProperty('code', 'ASSERTION_FAILED');
    }
  });

  test('time out a sample on a page that stops answering before the first read', async ({ browser }) => {
    await browser.goto(stuckEarly);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const error = await failure(() => expect(browser).toHaveClass(browser.locator('#stuck'), 'b', { timeout: 1000 }));
    expect(error).toHaveProperty('code', 'ACTION_FAILED');
  });

  test('compare the class list with its whitespace collapsed, and fail no class attribute', async ({ browser }) => {
    await browser.goto(page);
    await expect(browser).toHaveClass(browser.locator('#spaced'), 'a b');
    await expect(browser).not.toHaveClass(browser.locator('#holder'), '');
  });

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

  test('refuse a look-alike at once, whatever its count() answers', async ({ browser }) => {
    await browser.goto(page);
    for (const count of [0, 1]) {
      const target = { count: async () => count, getAttribute: async () => 'x' } as never;
      for (const [api, call] of [
        ['expect.toHaveClass', () => expect(browser).toHaveClass(target, 'x')],
        ['expect.toHaveCSS', () => expect(browser).toHaveCSS(target, 'position', 'x')],
        ['expect.toHaveJSProperty', () => expect(browser).toHaveJSProperty(target, 'id', 'x')],
      ] as const) {
        const started = Date.now();
        const error = await failure(call);
        expect(error).toHaveProperty('code', 'INVALID_LOCATOR');
        expect(error).toHaveProperty('message', `${api} requires an e2e locator`);
        expect(Date.now() - started).toBeLessThan(1000);
      }
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

  test('is refused at once, even while it matches nothing', async ({ browser }) => {
    await browser.goto(page);
    const target = missing!;
    const calls = [
      ['expect.toHaveClass', () => expect(browser).toHaveClass(target, 'x')],
      ['expect.toHaveCSS', () => expect(browser).toHaveCSS(target, 'position', 'sticky')],
      ['expect.not.toHaveJSProperty', () => expect(browser).not.toHaveJSProperty(target, 'id', 'never')],
    ] as const;
    for (const [api, call] of calls) {
      const started = Date.now();
      const error = await failure(call);
      expect(error).toHaveProperty('code', 'INVALID_LOCATOR');
      expect(error).toHaveProperty('message', expect.stringContaining(`${api} requires a locator made by this screen`));
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
});
