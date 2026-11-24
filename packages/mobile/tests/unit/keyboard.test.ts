import { describe, expect, it } from 'vitest';
import { keyboardDragStart } from '../../src/keyboard.ts';
import { projectSnapshot } from '../../src/nodes.ts';

describe('where a keyboard-dismissing drag starts, beside nodes agent-device marks covered (#1324)', () => {
  const SCREEN = { width: 390, height: 844 };

  it('keeps a covered leaf out of where a keyboard-dismissing drag may start, plain text included', () => {
    // Text at the screen's middle, where the drag would otherwise start: only its covered mark makes it an obstacle.
    const saved = { x: 145, y: 372, width: 100, height: 100 };
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Form', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'StaticText', label: 'Draft saved', interactionBlocked: 'covered', rect: saved },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    expect(projected.index.find((entry) => entry.node.name === 'Draft saved')?.node.states).toEqual({ hidden: true });
    const start = keyboardDragStart(projected, SCREEN, 700);
    expect(start).toBeDefined();
    const inside = start!.x >= saved.x - 8 && start!.x <= saved.x + saved.width + 8 && start!.y >= saved.y - 8 && start!.y <= saved.y + saved.height + 8;
    expect(inside).toBe(false);
  });

  it('prefers a clear scroll view to one agent-device marks covered for a keyboard-dismissing drag', () => {
    // The covered list holds the screen's middle; the drag starts in the clear one below it.
    const covered = { x: 0, y: 300, width: 390, height: 240 };
    const clear = { x: 0, y: 560, width: 390, height: 120 };
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Form', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'ScrollView', identifier: 'covered-list', interactionBlocked: 'covered', rect: covered },
        { index: 2, parentIndex: 1, type: 'StaticText', label: 'Row 1', rect: { x: 16, y: 310, width: 200, height: 20 } },
        { index: 3, parentIndex: 0, type: 'ScrollView', identifier: 'clear-list', rect: clear },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    const start = keyboardDragStart(projected, SCREEN, 700);
    expect(start).toBeDefined();
    expect(start!.y >= clear.y && start!.y <= clear.y + clear.height).toBe(true);
  });

  it('starts a keyboard-dismissing drag in the only scroll view, though agent-device marks it covered', () => {
    // A list in the top half whose centre agent-device found under something: a drag outside it would do nothing.
    const list = { x: 0, y: 100, width: 390, height: 250 };
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Form', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'ScrollView', identifier: 'list', interactionBlocked: 'covered', rect: list },
        { index: 2, parentIndex: 1, type: 'StaticText', label: 'Row 1', rect: { x: 16, y: 110, width: 200, height: 20 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    const start = keyboardDragStart(projected, SCREEN, 700);
    expect(start).toBeDefined();
    expect(start!.y >= list.y && start!.y <= list.y + list.height).toBe(true);
  });

  it('does not block a keyboard-dismissing drag with a covered scroll view that lists no children, or a covered leaf the size of the screen', () => {
    // agent-device tests only the centre, and a leaf this large is content merged into one element.
    let counter = 0;
    const feed = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Feed', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'ScrollView', identifier: 'feed', interactionBlocked: 'covered', rect: { x: 0, y: 0, width: 390, height: 844 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    expect(keyboardDragStart(feed, SCREEN, 700)).toEqual({ x: 195, y: 422 });
    const poster = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Poster', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'Image', label: 'Poster', interactionBlocked: 'covered', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 2, parentIndex: 0, type: 'ScrollView', identifier: 'notes', rect: { x: 0, y: 300, width: 390, height: 240 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    expect(keyboardDragStart(poster, SCREEN, 700)).toEqual({ x: 195, y: 422 });
  });

  it('starts a keyboard-dismissing drag in a covered full-screen scroll view when the screen has no other', () => {
    // A full-screen list whose centre agent-device found under something, and no other scroll view.
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Form', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'ScrollView', identifier: 'feed', interactionBlocked: 'covered', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 2, parentIndex: 1, type: 'StaticText', label: 'Row 1', rect: { x: 16, y: 120, width: 200, height: 20 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    expect(keyboardDragStart(projected, SCREEN, 700)).toEqual({ x: 195, y: 422 });
  });

  it('does not let a covered container block a keyboard-dismissing drag: agent-device tests only its centre', () => {
    // A covered card at the centre of a clear list: being covered makes no container an obstacle.
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Feed', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'ScrollView', identifier: 'feed', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 2, parentIndex: 1, type: 'Other', identifier: 'card', interactionBlocked: 'covered', rect: { x: 95, y: 322, width: 200, height: 200 } },
        { index: 3, parentIndex: 2, type: 'StaticText', label: 'Card', rect: { x: 110, y: 330, width: 100, height: 20 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    expect(keyboardDragStart(projected, SCREEN, 700)).toEqual({ x: 195, y: 422 });
  });

  it('falls back to a covered scroll view when no clear one has a point to start from', () => {
    // A clear carousel under the keyboard has no point above it, so the covered full-screen list takes the drag.
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Feed', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'ScrollView', identifier: 'feed', interactionBlocked: 'covered', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 2, parentIndex: 1, type: 'TextField', label: 'Search', rect: { x: 20, y: 150, width: 350, height: 44 } },
        { index: 3, parentIndex: 0, type: 'ScrollView', identifier: 'carousel', rect: { x: 0, y: 640, width: 390, height: 120 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    expect(keyboardDragStart(projected, SCREEN, 583)).toEqual({ x: 195, y: 422 });
  });

  it('starts a keyboard-dismissing drag in a clear scroll view away from a covered one nested in it', () => {
    const inner = { x: 0, y: 322, width: 390, height: 200 };
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Page', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'ScrollView', identifier: 'page', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 2, parentIndex: 1, type: 'ScrollView', identifier: 'inner', interactionBlocked: 'covered', rect: inner },
        { index: 3, parentIndex: 2, type: 'StaticText', label: 'Row 1', rect: { x: 16, y: 330, width: 200, height: 20 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    const start = keyboardDragStart(projected, SCREEN, 583);
    expect(start).toBeDefined();
    expect(start!.y >= inner.y && start!.y <= inner.y + inner.height).toBe(false);
  });

  it('does not count a covered mark under the keyboard when choosing where the drag starts', () => {
    // On Android agent-device marks a list whose centre is under the keyboard covered; that mark is the keyboard's.
    const screen = { width: 1080, height: 2400 };
    const list = { x: 0, y: 600, width: 1080, height: 1800 };
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'android.widget.FrameLayout', rect: { x: 0, y: 0, width: 1080, height: 2400 } },
        { index: 1, parentIndex: 0, type: 'androidx.recyclerview.widget.RecyclerView', identifier: 'chips', rect: { x: 0, y: 300, width: 1080, height: 140 } },
        { index: 2, parentIndex: 1, type: 'android.widget.Button', label: 'All', rect: { x: 0, y: 300, width: 500, height: 140 } },
        { index: 3, parentIndex: 0, type: 'android.widget.ScrollView', identifier: 'results', interactionBlocked: 'covered', rect: list },
        { index: 4, parentIndex: 3, type: 'android.widget.TextView', label: 'Result', rect: { x: 24, y: 620, width: 600, height: 60 } },
      ],
      { mintId: () => `n${++counter}`, viewport: screen, keyboard: { x: 0, y: 1500, width: 1080, height: 900 } },
    );
    expect(projected.index.find((entry) => entry.node.testId === 'results')?.covered).toBe(false);
    const start = keyboardDragStart(projected, screen, 1500);
    expect(start).toBeDefined();
    expect(start!.y >= list.y && start!.y <= 1500).toBe(true);
  });

  it('counts a covered leaf beside a keyboard narrower than the screen when choosing where the drag starts', () => {
    // A keyboard docked right, as one-handed: the text's centre is below the keyboard's top but beside it, so the mark is a real cover.
    const saved = { x: 145, y: 372, width: 100, height: 100 };
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Form', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'StaticText', label: 'Draft saved', interactionBlocked: 'covered', rect: saved },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN, keyboard: { x: 245, y: 400, width: 145, height: 444 } },
    );
    expect(projected.index.find((entry) => entry.node.name === 'Draft saved')?.covered).toBe(true);
    // The nearest point above the keyboard clear of the text, 8 points around it included.
    expect(keyboardDragStart(projected, SCREEN, 400)).toEqual({ x: 195, y: 363.5 });
  });

  it('starts a keyboard-dismissing drag on a node the platform reports not shown', () => {
    let counter = 0;
    const projected = projectSnapshot(
      [
        { index: 0, depth: 0, type: 'Application', label: 'Form', rect: { x: 0, y: 0, width: 390, height: 844 } },
        { index: 1, parentIndex: 0, type: 'Button', label: 'Save', visibleToUser: false, rect: { x: 145, y: 372, width: 100, height: 100 } },
      ],
      { mintId: () => `n${++counter}`, viewport: SCREEN },
    );
    expect(keyboardDragStart(projected, SCREEN, 700)).toEqual({ x: 195, y: 422 });
  });
});
