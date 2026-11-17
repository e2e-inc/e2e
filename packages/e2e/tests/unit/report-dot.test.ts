import { describe, expect, it, vi } from 'vitest';
import { DotReporter } from '../../src/report/dot.ts';
import type { RunEvent } from '../../src/run/events.ts';
import type { OutputStream } from '../../src/run/process-output.ts';

const passed: RunEvent = {
  type: 'test-finished',
  seq: 1,
  at: new Date(0).toISOString(),
  result: {
    test: {
      kind: 'test',
      title: 'passes',
      titlePath: ['passes'],
      declarationIndex: 0,
      sessions: [],
      tags: [],
      source: undefined,
      file: 'tests/pass.e2e.ts',
      id: 'test-1',
      serialId: undefined,
    },
    target: { name: 'fake', platform: 'fake' },
    agent: 'default',
    repeat: 0,
    status: 'passed',
    selected: true,
    attempts: [],
  },
};

function capture() {
  const text = { stdout: '', stderr: '' };
  return {
    text,
    write: (stream: OutputStream, chunk: string) => {
      text[stream] += chunk;
    },
  };
}

describe('dot reporter output', () => {
  it.each(['stdout', 'stderr'] as const)('ends unfinished user %s before returning the terminal', (stream) => {
    const output = capture();
    const reporter = new DotReporter('stdout', output.write);

    reporter.show(stream, 'tail');
    reporter.end();

    expect(output.text[stream]).toBe('tail\n');
    expect(output.text[stream === 'stdout' ? 'stderr' : 'stdout']).toBe('');
  });

  it('tracks unfinished text separately for each destination', () => {
    const output = capture();
    const reporter = new DotReporter('stdout', output.write);

    reporter.show('stdout', 'stdout tail');
    reporter.show('stderr', 'stderr tail');
    reporter.show('stdout', '\n');
    reporter.end();

    expect(output.text).toEqual({ stdout: 'stdout tail\n', stderr: 'stderr tail\n' });
  });

  it('closes the shared stderr destination only once when stdout is reserved for JSON', () => {
    const output = capture();
    const reporter = new DotReporter('stderr', output.write);

    reporter.show('stdout', 'stdout tail');
    reporter.show('stderr', 'stderr tail');
    reporter.end();

    expect(output.text).toEqual({ stdout: '', stderr: 'stdout tailstderr tail\n' });
  });

  it('ignores empty output without breaking a progress row', () => {
    const output = capture();
    const reporter = new DotReporter('stdout', output.write);

    reporter.onEvent(passed);
    reporter.show('stdout', '');
    reporter.show('stderr', '');
    reporter.onEvent(passed);
    reporter.end();

    expect(output.text).toEqual({ stdout: '..\n', stderr: '' });
  });

  it('does not add blank lines to completed user output or repeated end calls', () => {
    const output = capture();
    const reporter = new DotReporter('stdout', output.write);

    reporter.show('stdout', 'complete\n');
    reporter.show('stderr', 'tail');
    reporter.end();
    reporter.end();

    expect(output.text).toEqual({ stdout: 'complete\n', stderr: 'tail\n' });
  });

  it('starts marks on a fresh line after unfinished user stdout', () => {
    const output = capture();
    const reporter = new DotReporter('stdout', output.write);

    reporter.show('stdout', 'tail');
    reporter.onEvent(passed);
    reporter.end();

    expect(output.text).toEqual({ stdout: 'tail\n.\n', stderr: '' });
  });

  it('lets a delegated output view own user text and its final flush', () => {
    const output = capture();
    const view = { show: vi.fn(), end: vi.fn() };
    const reporter = new DotReporter('stdout', output.write, view);

    reporter.onEvent(passed);
    reporter.show('stdout', 'tail');
    reporter.show('stderr', 'error tail');
    reporter.end();

    expect(output.text).toEqual({ stdout: '.\n', stderr: '' });
    expect(view.show.mock.calls).toEqual([['stdout', 'tail'], ['stderr', 'error tail']]);
    expect(view.end).toHaveBeenCalledOnce();
  });
});
