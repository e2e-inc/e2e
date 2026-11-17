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
  private line: 'empty' | 'marks' | 'text' = 'empty';

  constructor(
    private readonly stream: OutputStream,
    private readonly output: (stream: OutputStream, text: string) => void = writeTerminal,
    private readonly endOutput?: () => void,
  ) {}

  /** A retry contributes just the one mark its final verdict calls for. */
  onEvent(event: RunEvent): void {
    if (event.type === 'test-finished' && event.result.selected) {
      const prefix = this.line === 'text' ? '\n' : '';
      this.output(this.stream, prefix + marks[event.result.status]);
      this.line = 'marks';
    } else if (event.type === 'run-finished') {
      this.finishMarks();
    }
  }

  /** Leaves a progress line before printing already-redacted user output. */
  show(stream: OutputStream, text: string): void {
    this.finishMarks();
    const destination = stream === 'stdout' ? this.stream : stream;
    this.output(destination, text);
    if (destination === this.stream) this.line = text.endsWith('\n') ? 'empty' : 'text';
  }

  /** Releases any pending text in the destination view once the run is over. */
  end(): void {
    this.finishMarks();
    this.endOutput?.();
  }

  private finishMarks(): void {
    if (this.line === 'marks') {
      this.output(this.stream, '\n');
      this.line = 'empty';
    }
  }
}
