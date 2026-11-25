/** A role query finds what its matchers read, where Playwright's `getByRole` and the Chrome-matching reader disagree. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';

const PAGE = [
  '<div role="Article" aria-label="Post"><header aria-label="Post header">Post</header><footer aria-label="Post footer">Post</footer></div>',
  '<header aria-label="Site header">Site</header>',
  '<nav role="none"><header aria-label="Nav header">Nav</header></nav>',
  '<nav role="none" aria-label="N"><header aria-label="Conflict header">Kept</header></nav>',
  '<aside role="none" tabindex="0"><footer aria-label="Conflict footer">Kept</footer></aside>',
  '<div role="region"><header aria-label="Exact region header">Region</header></div>',
  '<div role="region group"><header aria-label="Region group header">Group</header></div>',
  '<div role="region "><header aria-label="Region spaced header">Spaced</header></div>',
  '<div role="doc-chapter article"><footer aria-label="Chapter footer">Chapter</footer></div>',
  '<div role="doc-foo article"><footer aria-label="Unknown footer">Unknown</footer></div>',
  '<ul><nav role="listitem"><header aria-label="In list header">Item</header></nav></ul>',
  '<div role="none list"><nav role="listitem"><header aria-label="Not in list header">Item</header></nav></div>',
  '<ul><div role="button"><nav role="listitem"><header aria-label="Behind button header">Item</header></nav></div></ul>',
  '<ul><label><nav role="listitem"><header aria-label="In label header">Item</header></nav></label></ul>',
  '<div role="group"><nav role="listitem"><header aria-label="In group header">Item</header></nav></div>',
  '<nav role="none" aria-hidden="false"><header aria-label="Aria hidden header">Item</header></nav>',
  '<nav role="region none" tabindex="0"><header aria-label="Behind region header">Item</header></nav>',
  '<nav role="none" contenteditable><header aria-label="Editing host header">Item</header></nav>',
  '<div role="region article"><header aria-label="Region article header">Item</header></div>',
  '<ul><pre><nav role="listitem"><header aria-label="In pre header">Item</header></nav></pre></ul>',
  '<ul><div role="generic"><nav role="listitem"><header aria-label="In generic header">Item</header></nav></div></ul>',
  '<ul><x-wrap><nav role="listitem"><header aria-label="In custom header">Item</header></nav></x-wrap></ul>',
  '<ul><div role="none"><nav role="listitem"><header aria-label="Through none header">Item</header></nav></div></ul>',
  '<div role="tree"><div role="treeitem"><nav role="treeitem"><header aria-label="Nested tree header">Item</header></nav></div></div>',
  '<div role="listbox"><div><nav role="option"><header aria-label="Through div header">Item</header></nav></div></div>',
  '<ul><span><nav role="listitem"><header aria-label="Through span header">Item</header></nav></span></ul>',
  '<ul><div role="presentation"><nav role="listitem"><header aria-label="Through presentation header">Item</header></nav></div></ul>',
  '<ul><div role="doc-chapter"><nav role="listitem"><header aria-label="Behind chapter header">Item</header></nav></div></ul>',
  '<ul><div role="bogus"><nav role="listitem"><header aria-label="Behind unknown header">Item</header></nav></div></ul>',
  '<ul><div role="doc-foo"><nav role="listitem"><header aria-label="Behind unknown doc header">Item</header></nav></div></ul>',
  '<ol><nav role="listitem"><header aria-label="In ol header">Item</header></nav></ol>',
  '<menu><nav role="listitem"><header aria-label="In menu header">Item</header></nav></menu>',
  '<div role="list"><nav role="listitem"><header aria-label="In role list header">Item</header></nav></div>',
  '<div role="directory"><nav role="listitem"><header aria-label="In directory header">Item</header></nav></div>',
  '<ul><slot><nav role="listitem"><header aria-label="Through slot header">Item</header></nav></slot></ul>',
  '<nav role="form"><header aria-label="Unnamed form header">Item</header></nav>',
  '<nav role="form" aria-label="F"><header aria-label="Named form header">Item</header></nav>',
  '<nav role="form none" tabindex="0"><header aria-label="Behind form header">Item</header></nav>',
  '<header contenteditable aria-label="Editable header">Edit</header>',
  '<footer contenteditable aria-label="Editable footer">Edit</footer>',
  '<h3 aria-disabled="TrUe">Archived</h3>',
  '<h3>Open</h3>',
].join('');

test('role queries agree with the matchers', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate((html) => { document.body.innerHTML = html; }, PAGE);
  await expect(screen.getByRole('banner', { name: 'Post header' })).toHaveCount(0);
  await expect(screen.getByRole('contentinfo', { name: 'Post footer' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'Site header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Nav header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Conflict header' })).toHaveCount(0);
  await expect(screen.getByRole('contentinfo', { name: 'Conflict footer' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'Exact region header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'Region group header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Region spaced header' })).toHaveRole('banner');
  await expect(screen.getByRole('contentinfo', { name: 'Chapter footer' })).toHaveRole('contentinfo');
  await expect(screen.getByRole('contentinfo', { name: 'Unknown footer' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'In list header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Not in list header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'Behind button header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'In label header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'In group header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Aria hidden header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Behind region header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Editing host header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'Region article header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'In pre header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'In generic header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'In custom header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Through none header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Nested tree header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Through div header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Through span header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Through presentation header' })).toHaveRole('banner');
  await expect(screen.getByRole('banner', { name: 'Behind chapter header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'Behind unknown header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'Behind unknown doc header' })).toHaveCount(0);
  for (const name of ['In ol header', 'In menu header', 'In role list header', 'In directory header', 'Through slot header', 'Named form header', 'Behind form header']) {
    await expect(screen.getByRole('banner', { name }), name).toHaveRole('banner');
  }
  await expect(screen.getByRole('banner', { name: 'Unnamed form header' })).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'Editable header' })).toHaveCount(1);
  await expect(screen.getByRole('contentinfo', { name: 'Editable footer' })).toHaveCount(1);
  await expect(screen.getByRole('heading', { name: 'Archived', disabled: false })).toHaveCount(0);
  await expect(screen.getByRole('heading', { name: 'Archived', disabled: true })).toBeDisabled();
  await expect(screen.getByRole('heading', { name: 'Open', disabled: false })).toBeEnabled();
  await expect(screen.getByRole('heading', { name: 'Open', disabled: true })).toHaveCount(0);
});

test('a disabled filter keeps the matches and order of the query without it', async ({ app, browser, screen }) => {
  await app.open('/');
  const closedRoot = (buttons: string) => browser.evaluate((html) => {
    document.body.innerHTML = '<div id="host"></div>';
    document.getElementById('host')!.attachShadow({ mode: 'closed' }).innerHTML = html;
  }, buttons);
  await closedRoot('<button>A</button><button>B</button>');
  await expect(screen.getByRole('button', { disabled: false })).toHaveCount(2);
  await expect(screen.getByRole('button', { disabled: true })).toHaveCount(0);
  await closedRoot('<button disabled>A</button><button disabled>B</button>');
  await expect(screen.getByRole('button', { disabled: true })).toHaveCount(2);
  await expect(screen.getByRole('button', { disabled: false })).toHaveCount(0);
  for (const mode of ['closed', 'open'] as const) {
    await browser.evaluate((shadowMode) => {
      document.body.innerHTML = '<div id="host"></div><button>Light</button>';
      document.getElementById('host')!.attachShadow({ mode: shadowMode }).innerHTML = '<button>Shadow</button>';
    }, mode);
    const buttons = screen.getByRole('button', { disabled: false });
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveText('Light');
    await expect(buttons.nth(1)).toHaveText('Shadow');
  }
});

test('reads a form whose field is named matches', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    document.body.innerHTML = '<form aria-label="Preferences"><input name="matches"><button>Save</button></form>' +
      '<form role="group" aria-label="Locked" aria-disabled="true"><input name="matches"><button type="button">Keep</button></form>';
  });
  await expect(screen.getByRole('form', { disabled: true }).getByText('Save')).toHaveCount(0);
  await expect(screen.getByRole('form', { disabled: false }).getByText('Save')).toHaveCount(1);
  await expect(screen.getByRole('group', { name: 'Locked', disabled: false }).getByText('Keep')).toHaveCount(0);
  await expect(screen.getByRole('group', { name: 'Locked', disabled: true }).getByText('Keep')).toHaveCount(1);
});

test('survives form fields that shadow the reader', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    document.body.innerHTML = '<form aria-label="Tagged"><input name="tagName"><header aria-label="Tagged header">Head</header><button>Save</button></form>' +
      '<form aria-label="Typed"><input name="nodeType"><button>Keep</button></form>';
  });
  await expect(screen.getByRole('form', { name: 'Tagged', disabled: false }).getByText('Save')).toHaveCount(1);
  await expect(screen.getByRole('form', { name: 'Tagged', disabled: true }).getByText('Save')).toHaveCount(0);
  await expect(screen.getByRole('banner', { name: 'Tagged header' })).toHaveRole('banner');
  await expect(screen.getByRole('form', { name: 'Typed', disabled: false }).getByText('Keep')).toHaveCount(1);
});

// Playwright's own role engine throws on a form field named getAttribute, on main too, so this page goes through getByText, which reaches the reader.
test('reads through a form whose fields shadow getAttribute, hasAttribute, and parentElement', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    document.body.innerHTML = '<form aria-label="Attr"><input name="getAttribute"><input name="hasAttribute"><input name="parentElement"><header>Site</header><button>Go</button></form>';
  });
  await expect(screen.getByText('Site')).toHaveRole('banner');
  await expect(screen.getByText('Go')).toBeEnabled();
});

test('keeps a match whose disabled read throws', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    customElements.define('broken-button', class extends HTMLElement {
      override getAttribute(name: string): string | null {
        if (name === 'aria-disabled') throw new Error('broken-button: not ready');
        return super.getAttribute(name);
      }
    });
    document.body.innerHTML = '<broken-button role="button" aria-label="Broken" tabindex="0"><span>Inner</span></broken-button>';
  });
  await expect(screen.getByRole('button', { name: 'Broken', disabled: false }).getByText('Inner')).toHaveCount(1);
  await expect(screen.getByRole('button', { name: 'Broken', disabled: true }).getByText('Inner')).toHaveCount(1);
});

test('walks to a shadow host for a context role', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    document.body.innerHTML = '<ul><div id="host"></div></ul>';
    document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = '<nav role="listitem"><header aria-label="Shadow list header">x</header></nav>';
  });
  await expect(screen.getByRole('banner', { name: 'Shadow list header' })).toHaveRole('banner');
});

test('reads the disabled state alone for a node the reader cannot read', async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.evaluate(() => {
    customElements.define('plan-group', class extends HTMLElement { get labels() { return ['Go']; } });
    document.body.innerHTML = '<plan-group role="button" aria-label="Go" aria-disabled="true"><span>GoText</span></plan-group>';
  });
  await expect(screen.getByRole('button', { name: 'Go', disabled: false }).getByText('GoText')).toHaveCount(0);
  await expect(screen.getByRole('button', { name: 'Go', disabled: true }).getByText('GoText')).toHaveCount(1);
  expect(await screen.getByRole('button', { name: 'Go', disabled: false }).count()).toBe(0);
});
`;

describe('role queries and the reader', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/roles.e2e.ts': SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('finds a landmark and a disabled state as the matchers read them', async () => {
    const outcome = await runExisting(project, { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'] as const } });
    const result = resultByTitle(outcome, 'role queries agree with the matchers');
    expect(result.attempts.at(-1)?.error, JSON.stringify(result.attempts.at(-1)?.error)).toBeUndefined();
    expect(result.status).toBe('passed');
    const ordered = resultByTitle(outcome, 'a disabled filter keeps the matches and order of the query without it');
    expect(ordered.attempts.at(-1)?.error, JSON.stringify(ordered.attempts.at(-1)?.error)).toBeUndefined();
    expect(ordered.status).toBe('passed');
    for (const title of ['reads a form whose field is named matches', 'survives form fields that shadow the reader', 'reads through a form whose fields shadow getAttribute, hasAttribute, and parentElement', 'keeps a match whose disabled read throws', 'walks to a shadow host for a context role']) {
      const form = resultByTitle(outcome, title);
      expect(form.attempts.at(-1)?.error, `${title}: ${JSON.stringify(form.attempts.at(-1)?.error)}`).toBeUndefined();
      expect(form.status, title).toBe('passed');
    }
    const unreadable = resultByTitle(outcome, 'reads the disabled state alone for a node the reader cannot read');
    expect(unreadable.attempts.at(-1)?.error, JSON.stringify(unreadable.attempts.at(-1)?.error)).toBeUndefined();
    expect(unreadable.status).toBe('passed');
  }, 120_000);
});
