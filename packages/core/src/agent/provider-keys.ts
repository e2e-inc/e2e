/**
 * What an executor does about the keys its agent signs in with. The run
 * redacts the provider keys it finds in the environment on its own; these
 * are for an executor that knows of others, or that cuts or keeps text
 * before the run sees it.
 */

import { processSecrets, registerProviderKey, registerProviderKeys } from '../run/secrecy.ts';

export { registerProviderKey, registerProviderKeys };

/**
 * `text` with every secret and provider key the process knows replaced by
 * its `<secret:name>` marker. The run redacts whatever an executor returns;
 * an executor calls this first on text it cuts short, since half a value is
 * no longer a match, and on text it keeps somewhere the run never reads.
 */
export function redactSecrets(text: string): string {
  return processSecrets.redact(text);
}
