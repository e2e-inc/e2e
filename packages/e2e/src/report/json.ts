/** The built-in `json` reporter: the report document to stdout, and nothing else there. */

import { builtin } from './builtin-id.ts';
import type { Report, Reporter } from '../run-types.ts';

/**
 * Prints the run's report-1 document to stdout once the run is over. It is
 * not interactive, so beside it alone the runner prints on stderr. The
 * document prints from `onSummary`, which a forced stop never skips.
 */
export function json(): Reporter {
  let report: Report | undefined;
  return builtin('json', {
    name: 'json',
    reportFiles(run) {
      report = run.report;
      return [];
    },
    onSummary() {
      if (report === undefined) return;
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      report = undefined;
    },
  });
}
