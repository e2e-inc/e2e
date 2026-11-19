import { readFileSync } from 'node:fs';
import { resolveExpression, type SemanticNode } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { projectSnapshot, type RawSnapshot } from '../../src/nodes.ts';

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

  it('reports a secure field as a password field with no value', () => {
    const { root } = project('macos/appkit-form');
    const password = byTestId(root, 'password')!;
    expect(password).toMatchObject({ role: 'textbox', name: 'Password', inputPurpose: 'password', states: { secure: true } });
    expect(password.value).toBeUndefined();
  });

  it("drops Chromium's anonymous wrappers and keeps the controls", () => {
    const { root } = project('macos/electron-form');
    const nodes = all(root);
    expect(nodes.filter((node) => node.role === 'group' && node.name === undefined)).toEqual([]);
    expect(byTestId(root, 'username')).toMatchObject({ role: 'textbox', value: 'alice' });
    expect(byTestId(root, 'remember')).toMatchObject({ role: 'checkbox', states: { checked: true } });
    expect(byTestId(root, 'password')).toMatchObject({ inputPurpose: 'password', states: { secure: true } });
  });

  it('answers role and test-id queries through the shared resolver', () => {
    const { root } = project('macos/electron-form');
    const [field] = resolveExpression(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true }, name: { kind: 'string', value: 'Username', exact: true } } },
      [root],
    );
    expect(field?.testId).toBe('username');
    expect(resolveExpression({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'password', exact: true } } }, [root])).toHaveLength(1);
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
