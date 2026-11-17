/** The caller's label for a check, as it opens a failure message. */

/** `text` after the caller's `message` and a colon, or `text` alone when there is no message. */
export function withMessage(message: string | undefined, text: string): string {
  return message === undefined ? text : `${message}: ${text}`;
}
