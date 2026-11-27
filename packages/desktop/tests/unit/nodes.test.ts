import { readFileSync } from 'node:fs';
import { type LocatorExpression, resolveExpression, type SemanticNode } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { locatable, projectSnapshot, withContainerText, type RawSnapshot } from '../../src/nodes.ts';

function load(name: string): RawSnapshot {
  return JSON.parse(readFileSync(new URL(`../fixtures/snapshots/${name}.json`, import.meta.url), 'utf8')) as RawSnapshot;
}

/** Ids as the surface hands them out: one per identity, kept across snapshots. */
function minter(): (identity: string | undefined) => string {
  const ids = new Map<string, string>();
  let fresh = 0;
  return (identity) => {
    if (identity === undefined) return `fresh${(fresh += 1)}`;
    if (!ids.has(identity)) ids.set(identity, `n${ids.size + 1}`);
    return ids.get(identity)!;
  };
}

function project(name: string) {
  return projectSnapshot(load(name), minter());
}

function all(node: SemanticNode): SemanticNode[] {
  return [node, ...(node.children ?? []).flatMap(all)];
}

function byTestId(root: SemanticNode, testId: string): SemanticNode | undefined {
  return all(root).find((node) => node.testId === testId);
}

describe('projectSnapshot', () => {
  it('maps an AppKit form onto the contract vocabulary', () => {
    const { root, bindings } = project('macos/appkit-form');
    expect(root).toMatchObject({ ref: { id: 'root' }, role: 'window', name: 'Spike Form' });
    expect(byTestId(root, 'username')).toMatchObject({ role: 'textbox', name: 'Username', value: 'bob', states: { focused: true } });
    expect(byTestId(root, 'remember')).toMatchObject({ role: 'checkbox', name: 'Remember me', states: { checked: false } });
    expect(byTestId(root, 'remember')?.value).toBeUndefined();
    expect(byTestId(root, 'plan')).toMatchObject({ role: 'combobox', name: 'Plan', value: 'Pro', states: { expanded: false } });
    expect(byTestId(root, 'sign-in')).toMatchObject({ role: 'button', name: 'Sign in' });
    const signIn = byTestId(root, 'sign-in')!;
    expect(bindings.get(signIn.ref.id)).toMatchObject({ ref: '@s1y1hxmo5pexrl:e5', actions: ['Click', 'SetFocus'] });
  });

  it("reads a heading's level from the app, else from its description", () => {
    const { root } = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'W',
          children: [
            { role: 'heading', name: 'Summary', level: 2 },
            { role: 'heading', name: 'Notes', description: 'heading level 3' },
            { role: 'heading', name: 'Plain' },
          ],
        },
      },
      minter(),
    );
    expect(all(root).filter((node) => node.role === 'heading').map((node) => [node.name, node.level])).toEqual([
      ['Summary', 2],
      ['Notes', 3],
      ['Plain', undefined],
    ]);
    const heading = (level: number) =>
      resolveExpression(
        { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true }, name: { kind: 'string', value: 'Summary', exact: true }, level } },
        [root],
      );
    expect(heading(2)).toHaveLength(1);
    expect(heading(1)).toEqual([]);
  });

  it('reports a secure field as a password field with no value', () => {
    const { root } = project('macos/appkit-form');
    const password = byTestId(root, 'password')!;
    expect(password).toMatchObject({ role: 'textbox', name: 'Password', inputPurpose: 'password', states: { secure: true } });
    expect(password.value).toBeUndefined();
  });

  it('drops anonymous wrappers and keeps the controls', () => {
    const { root } = project('macos/sign-in-form');
    const nodes = all(root);
    expect(nodes.filter((node) => node.role === 'group' && node.name === undefined)).toEqual([]);
    expect(byTestId(root, 'username')).toMatchObject({ role: 'textbox', name: 'Username' });
    expect(byTestId(root, 'password')).toMatchObject({ inputPurpose: 'password', states: { secure: true } });
  });

  it("keeps every Close button the driver reports: it leaves the window's own out by their subrole", () => {
    const { root } = project('macos/sign-in-form');
    expect(all(root).filter((node) => node.role === 'button').map((node) => node.name)).toEqual(['Sign in']);
    const small = { width: 16, height: 16 };
    // An app's own small Close button, even in the title bar beside another, is the app's.
    const panel = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Panel',
          bounds: { x: 100, y: 200, width: 400, height: 300 },
          children: [
            { role: 'button', name: 'Close', ref_id: '@s:e1', bounds: { x: 108, y: 208, ...small } },
            { role: 'button', name: 'Minimize', ref_id: '@s:e3', bounds: { x: 131, y: 208, ...small } },
          ],
        },
      },
      minter(),
    );
    expect(all(panel.root).filter((node) => node.role === 'button').map((node) => node.name)).toEqual(['Close', 'Minimize']);
  });

  it('marks no id stable that sits inside a look-alike, whose own id is new every snapshot', () => {
    const row = { role: 'row', children: [{ role: 'textfield', name: 'Name', ref_id: '@s:e1' }] };
    const screen = projectSnapshot({ snapshot_id: 's', tree: { role: 'window', name: 'W', children: [row, row, { role: 'textfield', name: 'Search', ref_id: '@s:e2' }] } }, minter());
    const stable = (name: string) => [...screen.bindings.values()].filter((binding) => binding.name === name).map((binding) => binding.stable);
    expect(stable('Name')).toEqual([false, false]);
    expect(stable('Search')).toEqual([true]);
  });

  it('answers role and test-id queries through the shared resolver', () => {
    const { root } = project('macos/sign-in-form');
    const [field] = resolveExpression(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true }, name: { kind: 'string', value: 'Username', exact: true } } },
      [root],
    );
    expect(field?.testId).toBe('username');
    expect(resolveExpression({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'password', exact: true } } }, [root])).toHaveLength(1);
  });

  it("reads an empty text field's value as the empty string, so getByDisplayValue('') finds it, and a password field's never", () => {
    const { root } = project('macos/sign-in-form');
    const empty = resolveExpression({ kind: 'query', query: { kind: 'displayValue', value: { kind: 'string', value: '', exact: true } } }, [root]);
    expect(empty.map((node) => node.testId)).toEqual(['username']);
    expect(byTestId(root, 'password')?.value).toBeUndefined();
  });

  it('gives a control the same identity in every snapshot, its value aside', () => {
    const mint = minter();
    const before = projectSnapshot(load('macos/appkit-form'), mint);
    const after = projectSnapshot(load('macos/sign-in-form'), mint);
    expect(byTestId(after.root, 'username')?.ref.id).toBe(byTestId(before.root, 'username')?.ref.id);
    expect(byTestId(after.root, 'sign-in')?.ref.id).toBe(byTestId(before.root, 'sign-in')?.ref.id);
    const ids = [...after.bindings.keys()];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives look-alike siblings new ids every snapshot, so one never takes over another', () => {
    const raw: RawSnapshot = {
      snapshot_id: 's1',
      tree: {
        role: 'window',
        name: 'List',
        children: [
          { role: 'button', name: 'Delete', ref_id: '@s1:e1' },
          { role: 'button', name: 'Delete', ref_id: '@s1:e2' },
          { role: 'button', name: 'Done', ref_id: '@s1:e3' },
        ],
      },
    };
    const mint = minter();
    const before = projectSnapshot(raw, mint);
    const after = projectSnapshot({ ...raw, tree: { ...raw.tree, children: raw.tree.children!.slice(1) } }, mint);
    const ids = (screen: typeof before, name: string) => (screen.root.children ?? []).filter((node) => node.name === name).map((node) => node.ref.id);
    expect(ids(after, 'Delete').some((id) => ids(before, 'Delete').includes(id))).toBe(false);
    expect(ids(after, 'Done')).toEqual(ids(before, 'Done'));
  });

  it('keeps an unnamed field its id while it is typed into', () => {
    const mint = minter();
    const field = (value: string): RawSnapshot => ({ snapshot_id: 's', tree: { role: 'window', name: 'Form', children: [{ role: 'textfield', ref_id: '@s:e1', value }] } });
    const ids = ['', 'a', 'ab'].map((value) => projectSnapshot(field(value), mint).root.children?.[0]?.ref.id);
    expect(new Set(ids).size).toBe(1);
  });

  it('reports a value whole, and an image by the contract role', () => {
    const long = 'x'.repeat(600);
    const { root } = projectSnapshot(
      { snapshot_id: 's', tree: { role: 'window', name: 'Form', children: [{ role: 'textfield', name: 'Notes', ref_id: '@s:e1', value: long }, { role: 'image', name: 'Logo' }] } },
      minter(),
    );
    expect(root.children?.[0]?.value).toBe(long);
    expect(root.children?.[1]?.role).toBe('image');
  });

  it('reports the read-only state toBeEditable reads: of a text field always, of a combo box only when it takes text', () => {
    const form = project('macos/sign-in-form').root;
    expect(byTestId(form, 'username')?.states).toMatchObject({ readonly: false });
    expect(byTestId(form, 'password')?.states).toMatchObject({ readonly: false });
    // A pop-up menu takes no text, which is not read-only: no state, as on a device.
    expect(byTestId(form, 'plan')?.states).not.toHaveProperty('readonly');
    const { root } = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Form',
          children: [
            { role: 'textfield', name: 'Order id', ref_id: '@s:e1', states: ['readonly'], available_actions: ['Click'] },
            { role: 'combobox', name: 'City', ref_id: '@s:e2', available_actions: ['Click', 'SetValue'] },
            { role: 'textfield', name: 'Unknown', ref_id: '@s:e3', available_actions: ['Click'] },
          ],
        },
      },
      minter(),
    );
    expect(root.children?.map((node) => node.states?.readonly)).toEqual([true, false, undefined]);
  });

  it('reads a control collapsed to no width or height as hidden, but not a container with children, listed or cut off', () => {
    const { root } = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Form',
          bounds: { x: 0, y: 0, width: 200, height: 200 },
          children: [
            { role: 'button', name: 'Collapsed', ref_id: '@s:e1', bounds: { x: 10, y: 10, width: 0, height: 20 } },
            { role: 'button', name: 'Shown', ref_id: '@s:e2', bounds: { x: 10, y: 40, width: 80, height: 20 } },
            { role: 'group', name: 'Wrapper', bounds: { x: 0, y: 0, width: 0, height: 0 }, children: [{ role: 'button', name: 'Inside', ref_id: '@s:e3', bounds: { x: 10, y: 70, width: 80, height: 20 } }] },
            { role: 'group', name: 'Deep', bounds: { x: 0, y: 0, width: 0, height: 0 }, children_count: 3 },
          ],
        },
      },
      minter(),
    );
    const byName = (name: string) => all(root).find((node) => node.name === name);
    expect(byName('Collapsed')?.states?.hidden).toBe(true);
    expect(byName('Shown')?.states?.hidden).toBeUndefined();
    expect(byName('Wrapper')?.states?.hidden).toBeUndefined();
    expect(byName('Deep')?.states?.hidden).toBeUndefined();
    expect(byName('Inside')?.states?.hidden).toBeUndefined();
  });

  it('reads everything under a hidden node as hidden, under a wrapper it leaves out too, and swipes none of it', () => {
    const pane = (name: string, ref: string) => ({ role: 'scrollarea', name, ref_id: ref, available_actions: ['Scroll'], children: [{ role: 'button', name: `${name} item`, ref_id: `${ref}b` }] });
    const screen = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Panes',
          children: [
            { role: 'group', states: ['hidden'], children: [pane('Drawer', '@s:e1')] },
            { role: 'group', name: 'Panel', states: ['hidden'], children: [{ role: 'button', name: 'Panel item', ref_id: '@s:e3' }] },
            pane('Main', '@s:e2'),
          ],
        },
      },
      minter(),
    );
    const byName = (name: string) => all(screen.root).find((node) => node.name === name);
    for (const name of ['Drawer', 'Drawer item', 'Panel', 'Panel item']) expect(byName(name)?.states?.hidden).toBe(true);
    expect(byName('Main')?.states?.hidden).toBeUndefined();
    expect(byName('Main item')?.states?.hidden).toBeUndefined();
    expect(screen.scrollTargets?.vertical).toBe(byName('Main')?.ref.id);
  });

  it('reads every node of a minimized window as hidden, the window itself too', () => {
    const { root } = projectSnapshot(load('macos/sign-in-form'), minter(), { minimized: true });
    expect(resolveExpression({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'window', exact: true }, visible: true } }, [root])).toEqual([]);
    expect(all(root).every((node) => node.states?.hidden === true)).toBe(true);
  });

  it("takes the window's title from its accessibility root, not the window list's app name", () => {
    const screen = projectSnapshot({ snapshot_id: 's', window: { id: 'w-1', title: 'SignInForm' }, tree: { role: 'window', name: 'Sign In', children: [] } }, minter());
    expect(screen.title).toBe('Sign In');
    expect(projectSnapshot({ snapshot_id: 's', window: { id: 'w-1', title: 'Untitled' }, tree: { role: 'window', children: [] } }, minter()).title).toBe('Untitled');
  });

  it('swipes the first visible, enabled node the driver offers Scroll, past a list or table that cannot scroll', () => {
    const screen = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Feed',
          children: [
            { role: 'table', name: 'Filters', ref_id: '@s:e1', available_actions: ['Select'] },
            { role: 'list', name: 'Sidebar', ref_id: '@s:e2', available_actions: ['Select'] },
            { role: 'scrollarea', name: 'Drawer', ref_id: '@s:e3', states: ['offscreen'], available_actions: ['Scroll'] },
            { role: 'scrollarea', name: 'Archive', ref_id: '@s:e4', states: ['disabled'], available_actions: ['Scroll'] },
            { role: 'group', name: 'Posts', ref_id: '@s:e5', available_actions: ['Scroll'] },
          ],
        },
      },
      minter(),
    );
    expect(screen.scrollTargets).toEqual({ vertical: screen.root.children?.[4]?.ref.id, horizontal: screen.root.children?.[4]?.ref.id });
  });

  it('swipes each way the first node that scrolls that way, past a carousel for a swipe down', () => {
    const screen = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Store',
          children: [
            { role: 'scrollarea', name: 'Carousel', ref_id: '@s:e1', available_actions: ['Scroll'], scroll_axes: ['horizontal'] },
            { role: 'scrollarea', name: 'List', ref_id: '@s:e2', available_actions: ['Scroll'], scroll_axes: ['vertical'] },
          ],
        },
      },
      minter(),
    );
    const [carousel, list] = screen.root.children ?? [];
    expect(screen.scrollTargets).toEqual({ vertical: list?.ref.id, horizontal: carousel?.ref.id });
  });

  it('counts a node with children it did not list as a cut-short tree', () => {
    const screen = projectSnapshot({ snapshot_id: 's', complete: true, tree: { role: 'window', name: 'W', children: [{ role: 'group', name: 'Deep', children_count: 3 }] } }, minter());
    expect(screen.truncated).toBe(true);
  });

  it('reads an open menu as on screen when the button that opened it scrolled out of view', () => {
    const screen = projectSnapshot(
      {
        snapshot_id: 's',
        complete: true,
        tree: {
          role: 'window',
          name: 'W',
          children: [
            {
              role: 'scrollarea',
              ref_id: '@s:area',
              children: [
                {
                  role: 'menubutton',
                  name: 'Sort',
                  ref_id: '@s:sort',
                  states: ['offscreen'],
                  children: [{ role: 'menu', ref_id: '@s:menu', children: [{ role: 'menuitem', name: 'By Priority', ref_id: '@s:item', available_actions: ['Click'] }] }],
                },
                { role: 'group', name: 'Pane', ref_id: '@s:pane', states: ['offscreen'], children: [{ role: 'button', name: 'Inside', ref_id: '@s:inside' }] },
              ],
            },
          ],
        },
      },
      minter(),
    );
    const named = (name: string) => all(screen.root).find((node) => node.name === name);
    expect(named('Sort')?.states?.hidden).toBe(true);
    expect(named('By Priority')?.states?.hidden).toBeUndefined();
    // Anything else under a node scrolled out of view is out of view with it.
    expect(named('Inside')?.states?.hidden).toBe(true);
  });

  describe('rows folded out of view', () => {
    const row = (title: string, y: number) => ({
      role: 'treeitem',
      name: 'Low',
      ref_id: `@s:${title}`,
      bounds: { x: 0, y, width: 300, height: 24 },
      children: [{ role: 'checkbox', name: title, ref_id: `@s:${title}-box`, bounds: { x: 4, y, width: 200, height: 24 } }],
    });
    const list = (rows: readonly unknown[], beside: readonly unknown[] = []): RawSnapshot =>
      ({
        snapshot_id: 's',
        complete: true,
        window: { id: '7' },
        tree: { role: 'window', name: 'W', bounds: { x: 0, y: 0, width: 400, height: 300 }, children: [...beside, { role: 'scrollarea', ref_id: '@s:area', bounds: { x: 0, y: 0, width: 400, height: 300 }, children: [{ role: 'outline', name: 'Tasks', ref_id: '@s:list', children: rows }] }] },
      }) as RawSnapshot;
    const query = (kind: 'role' | 'text', value: string, name?: string, exact = true): LocatorExpression => ({
      kind: 'query',
      query: { kind, value: { kind: 'string', value, exact }, ...(name === undefined ? {} : { name: { kind: 'string', value: name, exact: true } }) },
    });

    it('reads a run of folded rows as one hidden line that counts them, which nothing acts on', () => {
      const screen = projectSnapshot(list([{ role: 'folded', folded: 3 }, row('Task 4', 0), row('Task 5', 24), { role: 'folded', folded: 1 }]), minter());
      const tasks = all(screen.root).find((node) => node.name === 'Tasks')!;
      expect(tasks.children?.map((child) => child.text ?? child.name)).toEqual(['3 rows out of view', 'Low', 'Low', '1 row out of view']);
      const marker = tasks.children![0]!;
      expect(marker.role).toBeUndefined();
      expect(marker.states).toEqual({ hidden: true });
      expect(screen.bindings.get(marker.ref.id)).toMatchObject({ actions: [], stable: false });
      expect(screen.bindings.get(marker.ref.id)?.ref).toBeUndefined();
      // A fold is no cut: the read is whole, so a locator counts its matches.
      expect(screen.truncated).toBe(false);
      expect(screen.cutShort).toBe(false);
    });

    it('finds the rows in view and none folded out of it, by any query', () => {
      const screen = projectSnapshot(list([row('Task 1', 0), row('Task 2', 24), { role: 'folded', folded: 198 }]), minter());
      const root = locatable(screen);
      expect(resolveExpression(query('role', 'checkbox', 'Task 2'), [root])).toHaveLength(1);
      expect(resolveExpression(query('role', 'checkbox', 'Task 200'), [root])).toHaveLength(0);
      expect(resolveExpression(query('text', 'Task 200'), [root])).toHaveLength(0);
    });

    it('never matches the fold line itself, so a loose text query stays unique', () => {
      const view = { role: 'button', name: 'View', ref_id: '@s:view', bounds: { x: 0, y: 0, width: 60, height: 20 } };
      const screen = projectSnapshot(list([row('Task 1', 0), { role: 'folded', folded: 182 }], [view]), minter());
      const loose = (text: string) => resolveExpression(query('text', text, undefined, false), [locatable(screen)]);
      expect(loose('View')).toHaveLength(1);
      expect(loose('rows')).toHaveLength(0);
      expect(loose('182')).toHaveLength(0);
      // A reader still sees it.
      expect(all(screen.root).some((node) => node.text === '182 rows out of view')).toBe(true);
    });

    it('gives no row beside a fold an id the next read keeps, since a folded row may be its twin', () => {
      const ids = minter();
      const first = projectSnapshot(list([row('Task 1', 0), { role: 'folded', folded: 5 }]), ids);
      const second = projectSnapshot(list([row('Task 1', 0), { role: 'folded', folded: 5 }]), ids);
      const box = (screen: typeof first) => all(screen.root).find((node) => node.name === 'Task 1')!;
      expect(box(first).ref.id).not.toBe(box(second).ref.id);
      expect(first.bindings.get(box(first).ref.id)?.stable).toBe(false);
      // The list itself keeps its id.
      const tasks = (screen: typeof first) => all(screen.root).find((node) => node.name === 'Tasks')!;
      expect(tasks(first).ref.id).toBe(tasks(second).ref.id);
    });
  });

  it('reads a placeholder from its own field, not from a hint', () => {
    const { root } = projectSnapshot({ snapshot_id: 's', tree: { role: 'window', name: 'W', children: [{ role: 'textfield', name: 'Email', placeholder: 'Email address', hint: 'column 1 of 2', ref_id: '@s:e1' }] } }, minter());
    expect(root.children?.[0]?.attributes).toMatchObject({ placeholder: 'Email address', hint: 'column 1 of 2' });
  });

  it('reads a node\'s name and developer id as its label and identifier attributes', () => {
    const { root } = projectSnapshot({ snapshot_id: 's', tree: { role: 'window', name: 'W', children: [{ role: 'button', name: 'Delete', native_id: { kind: 'ax_identifier', value: 'delete' }, ref_id: '@s:e1' }] } }, minter());
    expect(root.children?.[0]?.attributes).toMatchObject({ label: 'Delete', identifier: 'delete' });
  });

  it('gives a text node, and a name longer than any control has, no label, so no paragraph rides along whole in an observation', () => {
    const paragraph = 'word '.repeat(20_000);
    const { root } = projectSnapshot(
      { snapshot_id: 's', tree: { role: 'window', name: 'W', children: [{ role: 'statictext', value: paragraph }, { role: 'button', name: paragraph, ref_id: '@s:e1' }, { role: 'statictext', value: 'Signed in' }] } },
      minter(),
    );
    // A short text gets none either: its name is its text, which textContent reads.
    expect(root.children?.map((child) => child.attributes?.label)).toEqual([undefined, undefined, undefined]);
  });

  it('keeps ids for siblings that share a developer id but not a name', () => {
    const mint = minter();
    const ids = (screen: ReturnType<typeof projectSnapshot>) => all(screen.root).filter((node) => node.role === 'menuitem').map((node) => node.ref.id);
    const item = (name: string, index: number) => ({ role: 'menuitem', name, native_id: { kind: 'ax_identifier', value: 'menuItemSelected:' }, ref_id: `@m:e${index}`, available_actions: ['Click'] });
    const menu: RawSnapshot = { snapshot_id: 'm', tree: { role: 'menu', children: [item('Free', 1), item('Pro', 2), item('Team', 3)] } };
    const first = ids(projectSnapshot(menu, mint));
    const second = ids(projectSnapshot(menu, mint));
    expect(new Set(first).size).toBe(3);
    expect(second).toEqual(first);
  });

  it('keeps a status its id while its text changes', () => {
    const mint = minter();
    const status = (text: string): RawSnapshot => ({ snapshot_id: 's', tree: { role: 'window', name: 'W', children: [{ role: 'statictext', value: text, native_id: { kind: 'ax_identifier', value: 'status' } }] } });
    expect(projectSnapshot(status('Not signed in'), mint).root.children?.[0]?.ref.id).toBe(projectSnapshot(status('Signed in'), mint).root.children?.[0]?.ref.id);
  });

  it('never lets a developer id and a name spell another control\'s identity', () => {
    const raw: RawSnapshot = {
      snapshot_id: 's',
      tree: {
        role: 'window',
        name: 'W',
        children: [
          { role: 'button', name: 'Edit:', native_id: { kind: 'ax_identifier', value: 'shared' }, ref_id: '@s:e1' },
          { role: 'button', name: 'Copy', native_id: { kind: 'ax_identifier', value: 'shared' }, ref_id: '@s:e2' },
          { role: 'button', name: 'Archived', native_id: { kind: 'ax_identifier', value: 'shared:Edit' }, ref_id: '@s:e3' },
        ],
      },
    };
    const ids = projectSnapshot(raw, minter()).root.children!.map((node) => node.ref.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps a secure field a wrapper would hide, so its bounds are masked', () => {
    const screen = projectSnapshot(
      { snapshot_id: 's', tree: { role: 'window', name: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'group', states: ['secure'], bounds: { x: 10, y: 10, width: 50, height: 20 } }] } },
      minter(),
    );
    expect(screen.secureRects).toEqual([{ x: 10, y: 10, width: 50, height: 20 }]);
  });

  it('withholds masking for a secure field whose box has no area', () => {
    const screen = projectSnapshot({ snapshot_id: 's', tree: { role: 'window', name: 'W', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'textfield', states: ['secure'], ref_id: '@s:e1', bounds: { x: 10, y: 10, width: 0, height: 0 } }] } }, minter());
    expect(screen.secureRects).toBeUndefined();
  });

  it('gives a control its title as its text, and an input none', () => {
    const { root } = project('macos/sign-in-form');
    expect(byTestId(root, 'sign-in')).toMatchObject({ name: 'Sign in', text: 'Sign in' });
    expect(byTestId(root, 'username')?.text).toBeUndefined();
  });

  it('withholds masking when a secure field has no bounds, and measures rects from the window', () => {
    expect(project('macos/appkit-form').secureRects).toBeUndefined();
    const raw = load('macos/appkit-form');
    const bounded: RawSnapshot = {
      ...raw,
      tree: {
        ...raw.tree,
        bounds: { x: 100, y: 50, width: 400, height: 300 },
        children: raw.tree.children!.map((child) => ({ ...child, bounds: { x: 120, y: 90, width: 260, height: 22 } })),
      },
    };
    const screen = projectSnapshot(bounded, minter());
    expect(screen.viewport).toEqual({ width: 400, height: 300 });
    expect(screen.secureRects).toEqual([{ x: 20, y: 40, width: 260, height: 22 }]);
  });

  it('measures every rect from the window on a real capture', () => {
    const screen = project('macos/sign-in-form');
    expect(screen.viewport).toEqual({ width: 420, height: 352 });
    expect(screen.secureRects).toEqual([{ x: 19, y: 110, width: 262, height: 26 }]);
    expect(screen.windowId).toBeDefined();
    expect(byTestId(screen.root, 'status')).toMatchObject({ role: 'text', name: 'Not signed in', text: 'Not signed in', rect: { x: 19, y: 230 } });
  });
});

describe('withContainerText', () => {
  /** A SwiftUI list as the driver reads it: rows of a checkbox, a priority label, and a button, under wrappers that are dropped. */
  const list = (): SemanticNode => {
    const { root } = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Inbox',
          children: [
            {
              role: 'outline',
              ref_id: '@s:e1',
              native_id: { kind: 'ax_identifier', value: 'tasks' },
              children: [
                {
                  role: 'row',
                  ref_id: '@s:e2',
                  children: [
                    {
                      role: 'cell',
                      children: [
                        { role: 'checkbox', ref_id: '@s:e3', name: 'Buy milk', available_actions: ['Click'] },
                        { role: 'group', children: [{ role: 'statictext', value: 'Medium' }] },
                        { role: 'button', ref_id: '@s:e4', name: 'Delete Buy milk', available_actions: ['Click'] },
                      ],
                    },
                  ],
                },
                { role: 'row', ref_id: '@s:e5', children: [{ role: 'cell', children: [{ role: 'statictext', value: 'Call the bank' }, { role: 'textfield', ref_id: '@s:e6', name: 'Note', value: 'typed' }] }] },
              ],
            },
            { role: 'group', native_id: { kind: 'ax_identifier', value: 'empty' }, name: 'Empty pane', children: [{ role: 'image', ref_id: '@s:e7' }] },
            { role: 'statictext', value: 'Ready', native_id: { kind: 'ax_identifier', value: 'status' }, children: [{ role: 'statictext', value: 'Rea' }] },
          ],
        },
      },
      minter(),
    );
    return root;
  };

  it('gives a list, and each row, the text its rows and labels show, one line each', () => {
    const root = list();
    const tasks = withContainerText(byTestId(root, 'tasks')!);
    expect(byTestId(root, 'tasks')?.text).toBeUndefined();
    expect(tasks.text).toBe('Buy milk\nMedium\nDelete Buy milk\nCall the bank');
    const [first] = resolveExpression({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'row', exact: true } } }, [root]);
    expect(withContainerText(first!).text).toBe('Buy milk\nMedium\nDelete Buy milk');
  });

  it('reads the rows in view of a list with folded rows, and not the line that counts the rest', () => {
    const screen = projectSnapshot(
      {
        snapshot_id: 's',
        complete: true,
        tree: {
          role: 'window',
          name: 'Inbox',
          children: [
            {
              role: 'outline',
              ref_id: '@s:e1',
              native_id: { kind: 'ax_identifier', value: 'tasks' },
              children: [{ role: 'row', ref_id: '@s:e2', children: [{ role: 'statictext', value: 'Buy milk' }] }, { role: 'folded', folded: 182 }],
            },
          ],
        },
      },
      minter(),
    );
    const [tasks] = resolveExpression({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'tasks', exact: true } } }, [locatable(screen)]);
    expect(withContainerText(tasks!).text).toBe('Buy milk');
    // Taken from the whole tree, the fold line is there, hidden, and adds nothing either.
    expect(withContainerText(byTestId(screen.root, 'tasks')!).text).toBe('Buy milk');
  });

  it("keeps a field's own text, whatever hint the app lists under it", () => {
    const { root } = projectSnapshot(
      {
        snapshot_id: 's',
        tree: {
          role: 'window',
          name: 'Inbox',
          children: [{ role: 'textfield', ref_id: '@s:e1', name: 'Note', native_id: { kind: 'ax_identifier', value: 'note' }, value: 'typed', children: [{ role: 'statictext', value: 'Hint' }] }],
        },
      },
      minter(),
    );
    const note = byTestId(root, 'note')!;
    expect(withContainerText(note).text).toBe(note.text);
    expect(withContainerText(note).text ?? '').not.toContain('Hint');
  });

  it("leaves out a field's value, as an input's text content on the web is empty", () => {
    expect(withContainerText(byTestId(list(), 'tasks')!).text).not.toContain('typed');
  });

  it('keeps the own text of static text, of a leaf, and of a container with no text under it', () => {
    const root = list();
    expect(withContainerText(byTestId(root, 'status')!).text).toBe('Ready');
    const checkbox = all(root).find((node) => node.name === 'Buy milk')!;
    expect(withContainerText(checkbox)).toBe(checkbox);
    expect(withContainerText(byTestId(root, 'empty')!).text).toBe('Empty pane');
  });
});
