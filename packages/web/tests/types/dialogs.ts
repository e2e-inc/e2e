/** Compile-time assertions for `web({ dialogs })`: the two answers a dialog no handler takes gets. */
import { web, type DialogPolicy } from '../../src/index.ts';

web({ dialogs: 'accept' });
web({ dialogs: 'dismiss' });
void ('accept' satisfies DialogPolicy);

// @ts-expect-error a policy is accept or dismiss, not any string.
web({ dialogs: 'ok' });
// @ts-expect-error a function handler belongs to browser.onDialog in the test.
web({ dialogs: () => undefined });
// @ts-expect-error a policy is a string, not a boolean.
web({ dialogs: true });
