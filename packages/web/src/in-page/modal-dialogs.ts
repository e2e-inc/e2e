/**
 * Modal dialogs for the reader: a modal `<dialog>` makes everything outside
 * it inert, and only the one shown last stays live when several are open,
 * which neither tree order nor `dialog:modal` tells apart. The init script
 * keeps the order they were shown in, and `createModalScope` reads from it
 * what the dialog on top leaves of the page.
 */

import type { Dom } from './dom.ts';

/**
 * Where the init script below records each modal dialog's show order, and
 * where `createModalScope` looks for it. That function is serialized into
 * the page and cannot import this constant, so it takes it as an argument.
 */
export const MODAL_ORDER_KEY = 'e2e.modalDialogOrder';

/**
 * Context init script that numbers each opening of a dialog that
 * `showModal()` has shown: a `WeakMap` from dialog to the count of openings
 * so far, under a well-known symbol, so the highest number among the open
 * modal dialogs is the one on top. Such a dialog can open again without
 * `showModal()` (a `show-modal` command), so the first `showModal()` call
 * also listens for the dialog's `beforetoggle` to `open`, which every
 * opening fires before it happens, and numbers it there; a browser that fires
 * none on a dialog is numbered by the call itself. A call on a dialog already
 * open records nothing: on a modal one it changes nothing, and on one shown
 * without a modal it throws, as it does on a dialog that is not connected. A
 * dialog no `showModal()` call has seen gets no number, and the reader reads
 * the order as unknown. Keyed by the dialog and never enumerated, so it holds
 * nothing alive. A browser without `showModal` gets no record, and the reader
 * goes by focus alone.
 */
export const MODAL_ORDER_INIT_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(MODAL_ORDER_KEY)});
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') return;
  const order = new WeakMap();
  const watched = new WeakSet();
  let opened = 0;
  Object.defineProperty(globalThis, key, { value: order, enumerable: false, configurable: false, writable: false });
  const listen = EventTarget.prototype.addEventListener;
  const number = (dialog) => {
    opened += 1;
    order.set(dialog, opened);
  };
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    const dialog = this;
    if (!watched.has(dialog)) {
      watched.add(dialog);
      listen.call(dialog, 'beforetoggle', (event) => {
        if (event.newState === 'open') number(dialog);
      });
    }
    const opens = !dialog.open;
    const before = order.get(dialog);
    const result = showModal.call(dialog);
    if (opens && order.get(dialog) === before) number(dialog);
    return result;
  };
})();`;

/** What an open modal dialog leaves of the page for the reader's walk (`createModalScope`). */
interface ModalScope {
  /**
   * Where an element sits: `inside` the dialog's flat tree, which stays
   * live; an `ancestor` the dialog sits under, through shadow hosts, walked
   * to reach it and never listed; or `outside`, which is inert.
   */
  readonly placeOf: (el: Element) => 'inside' | 'ancestor' | 'outside';
}

/**
 * Builds the read of what the modal dialog on top leaves of the document,
 * over the show order `MODAL_ORDER_INIT_SCRIPT` keeps under `key`, read when
 * asked, and the DOM helpers `dom`. Serialized into the page beside the
 * semantic reader whose walk asks it, so this is one self-contained
 * function under the rule `read-semantics.ts` states.
 *
 * Everything outside the modal dialog on top is inert (HTML's "blocked by a
 * modal dialog"), as Chrome's tree drops it, though it still paints: the
 * page behind, a lower modal dialog, a popover opened outside the dialog,
 * and a frame's whole document, which the engine then never enters. What
 * stays is the dialog and its flat-tree descendants, light children slotted
 * into it from outside its shadow root included. Its ancestors drop out of
 * the tree too, but are walked, since the dialog and those slotted children
 * are reached through them. The read takes `flatParentOf`, the reader's memo
 * of `dom.parentOf` for its read, and answers undefined when no modal dialog
 * is open, or when none can be told to be on top (`topModalOf`).
 */
export const createModalScope = (key: string, dom: Dom) => {
  /**
   * Whether `el` is an open modal `<dialog>`. `dialog:modal`, not `:modal`,
   * which a fullscreen element matches too; a browser that cannot parse the
   * selector has no modal to read, rather than a reader that throws.
   */
  const isOpenModalDialog = (el: Element): boolean => {
    if (el.localName !== 'dialog') return false;
    try {
      return el.matches('dialog:modal');
    } catch {
      return false;
    }
  };

  /**
   * Every open modal dialog under `root`, in tree order, through open and
   * closed shadow roots alike: `querySelectorAll` stops at a shadow boundary,
   * so each host's root is searched on its own.
   */
  const openModalDialogsIn = (root: Document | ShadowRoot, found: Element[] = []): Element[] => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (isOpenModalDialog(el)) found.push(el);
      const shadow = dom.shadowOf(el);
      if (shadow !== null) openModalDialogsIn(shadow, found);
    }
    return found;
  };

  /**
   * The modal dialog on top of several open ones, the only one left live: the
   * innermost one holding focus, since `showModal()` moves focus into the
   * dialog it shows and inert content cannot take focus back, and a modal
   * nested in another leaves the outer one's own controls inert; else the
   * one the init script saw shown last, for a page that blurred. Tree order
   * alone is wrong: `showModal()` on a later dialog, then an earlier one,
   * leaves the earlier one on top. When the record never saw one of them
   * (opened by a `show-modal` command, or before the script ran), nothing
   * tells which is on top, and none is picked: a guess can drop the one
   * dialog that takes input, which is worse than listing the page.
   */
  const topModalOf = (dialogs: readonly Element[], flatParentOf: (el: Element) => Element | null): Element | undefined => {
    if (dialogs.length <= 1) return dialogs[0];
    const open = new Set(dialogs);
    for (let current = dom.activeElement(); current !== null; current = flatParentOf(current)) {
      if (open.has(current)) return current;
    }
    const shown: WeakMap<Element, number> | undefined = Reflect.get(globalThis, Symbol.for(key));
    let top: Element | undefined;
    let topOrder = 0;
    for (const dialog of dialogs) {
      const order = shown?.get(dialog);
      if (order === undefined) return undefined;
      if (order > topOrder) {
        top = dialog;
        topOrder = order;
      }
    }
    return top;
  };

  return (flatParentOf: (el: Element) => Element | null): ModalScope | undefined => {
    const dialog = topModalOf(openModalDialogsIn(document), flatParentOf);
    if (dialog === undefined) return undefined;
    const ancestors = new Set<Element>();
    for (let up = dom.parentOrHostOf(dialog); up !== null; up = dom.parentOrHostOf(up)) ancestors.add(up);
    /** Whether `el` is the dialog or under it in the flat tree. */
    const isInside = (el: Element): boolean => {
      for (let current: Element | null = el; current !== null; current = flatParentOf(current)) {
        if (current === dialog) return true;
      }
      return false;
    };
    return { placeOf: (el) => (ancestors.has(el) ? 'ancestor' : isInside(el) ? 'inside' : 'outside') };
  };
};
