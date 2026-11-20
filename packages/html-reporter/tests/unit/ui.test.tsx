import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Report } from 'e2e';
import { buildModel } from '../../app/data.ts';
import { ListView } from '../../app/list.tsx';
import { StatusIcon, StatusTag } from '../../app/ui.tsx';
import fixture from '../../../e2e/schema/fixtures/report-v1.valid.json' with { type: 'json' };

const REPORT = fixture as unknown as Report;

describe('TODO status UI', () => {
  it('renders the TODO icon glyph and an explanation for the status tag', () => {
    const icon = renderToStaticMarkup(createElement(StatusIcon, { status: 'todo' }));
    const tag = renderToStaticMarkup(createElement(StatusTag, { status: 'todo' }));

    expect(icon).toContain('text-status-todo');
    expect(icon).toContain('aria-label="todo"');
    expect(icon).toContain('lucide-circle-dashed');
    expect(tag).toContain('>todo<');
    expect(tag).toContain('Not implemented yet; no attempt was run.');
  });

  it('includes TODO in the run bar and status filters', () => {
    const first = REPORT.run.results[0]!;
    const report: Report = {
      ...REPORT,
      run: {
        ...REPORT.run,
        results: [{ ...first, status: 'todo', attempts: [] }],
        summary: { ...REPORT.run.summary, discovered: 1, selected: 1, executed: 0, passed: 0, failed: 0, interrupted: 0, flaky: 0, skipped: 0, todo: 1 },
      },
    };
    const model = buildModel({ report, media: { mode: 'none' }, resultsDir: '.e2e/results', traces: {}, sources: {} });
    const list = renderToStaticMarkup(createElement(ListView, { model, status: 'all', search: '' }));

    expect(list).toContain('aria-label="1 todo"');
    expect(list).toContain('<span>todo</span>');
  });

  it('uses an interrupted-tone fallback for an unknown result status', () => {
    const status = 'queued' as Report['run']['results'][number]['status'];
    const icon = renderToStaticMarkup(createElement(StatusIcon, { status }));
    const tag = renderToStaticMarkup(createElement(StatusTag, { status }));

    expect(icon).toContain('text-status-interrupted');
    expect(icon).toContain('aria-label="queued"');
    expect(tag).toContain('text-status-interrupted');
    expect(tag).toContain('>queued<');
  });
});
