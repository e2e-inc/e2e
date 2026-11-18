/**
 * `NODE_DEBUG` sections that print credentials: `child_process` prints the
 * environment of every process this one starts, and `net` the options of
 * each `http.request`, its `Authorization` header included. Node decides
 * which sections are on once, at startup, so a run cannot turn one off. What
 * Node prints passes the run's output redaction, which knows the run's
 * secrets and provider keys and nothing else of an environment or a header.
 * The run says so and goes on: the variable is the developer's own debugging
 * switch.
 */

import { debuglog } from 'node:util';

const SECTION_PRINTS: Readonly<Record<string, string>> = {
  child_process: 'the environment of every process e2e starts',
  net: 'the headers of every request made with node:http',
};

/** Whether Node, as it started, prints `section`: its own reading of `NODE_DEBUG`, wildcards and case included. A runtime that keeps no such switch prints nothing. */
function nodePrints(section: string): boolean {
  return debuglog(section).enabled === true;
}

/**
 * The warning for a process started with `value` as `NODE_DEBUG`, or
 * `undefined` when no section that prints credentials is on. One line, so a
 * log reader finds it among Node's own.
 */
export function nodeDebugWarning(value: string | undefined, prints: (section: string) => boolean = nodePrints): string | undefined {
  if (value === undefined) return undefined;
  const on = Object.keys(SECTION_PRINTS).filter(prints);
  if (on.length === 0) return undefined;
  return `e2e: NODE_DEBUG=${value} makes Node print ${on.map((section) => SECTION_PRINTS[section]).join(' and ')}; e2e redacts its secrets and the provider keys it knows there, and every other token or password is printed as it is, so unset NODE_DEBUG unless you are debugging with it`;
}

let warned = false;

/** Writes the warning to stderr, once per process however many runs, hosts, or servers it starts. */
export function warnOfNodeDebug(prints: (section: string) => boolean = nodePrints): void {
  if (warned) return;
  warned = true;
  const warning = nodeDebugWarning(process.env['NODE_DEBUG'], prints);
  if (warning !== undefined) process.stderr.write(`${warning}\n`);
}
