/** One character for each selected test's final result, in completion order. */

import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { Reporter } from '../run-types.ts';
import type { RunEvent } from '../run/events.ts';
import { writeTerminal, type OutputStream, type OutputView } from '../run/process-output.ts';

const marks: Record<ResultStatus, string> = {
  passed: '.',
  flaky: '~',
  failed: 'F',
  'timed-out': 'T',
  interrupted: 'I',
  skipped: '-',
};

export class DotReporter implements Reporter, OutputView {
  readonly name = 'dot';
  private hasMarks = false;
  private readonly unfinished = new Set<OutputStream>();

  constructor(
    private readonly stream: OutputStream,
    private readonly output: (stream: OutputStream, text: string) => void = writeTerminal,
    private readonly userOutput?: OutputView,
  ) {}

  /** A retry contributes just the one mark its final verdict calls for. */
  onEvent(event: RunEvent): void {
    if (event.type === 'test-finished' && event.result.selected) {
      const prefix = this.unfinished.delete(this.stream) ? '\n' : '';
      this.output(this.stream, prefix + marks[event.result.status]);
      this.hasMarks = true;
    } else if (event.type === 'run-finished') {
      this.finishMarks();
    }
  }

  /** Leaves a progress line before printing already-redacted user output. */
  show(stream: OutputStream, text: string): void {
    if (text === '') return;
    this.finishMarks();
    if (this.userOutput !== undefined) {
      this.userOutput.show(stream, text);
      return;
    }
    const destination = stream === 'stdout' ? this.stream : stream;
    this.output(destination, text);
    if (text.endsWith('\n')) this.unfinished.delete(destination);
    else this.unfinished.add(destination);
  }

  /** Releases any pending text in the destination view once the run is over. */
  end(): void {
    this.finishMarks();
    for (const stream of this.unfinished) this.output(stream, '\n');
    this.unfinished.clear();
    this.userOutput?.end();
  }

  private finishMarks(): void {
    if (this.hasMarks) {
      this.output(this.stream, '\n');
      this.hasMarks = false;
    }
  }
}
