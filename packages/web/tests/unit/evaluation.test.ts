/**
 * The page-side evaluation boundary: the caller's source is inlined into a
 * fresh function, so it must run whatever the loader compiled it to. The tsx
 * loader of e2e before 0.17 emits esbuild `keepNames` output, which
 * references a module-scoped `__name` helper.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileEvaluation, evaluationValue, pageFunctionSource, pageValueEncoder, readEvaluation } from '../../src/evaluation.ts';
import { SECURE_FIELD_SELECTOR } from '../../src/read-node.ts';

/** What `browser.evaluate` returns for a page report. */
function decode(text: string): unknown {
  return evaluationValue(readEvaluation(text), 'evaluate');
}

/** Runs the compiled boundary in this process and decodes its report like `browser.evaluate`. */
async function run(source: string, hasArgument: boolean, arg?: unknown): Promise<unknown> {
  return decode(await compileEvaluation(source, hasArgument ? ['arg'] : [], { awaitResult: true })(arg));
}

describe('compileEvaluation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs a keepNames-compiled source that references __name', async () => {
    await expect(run('input=>{const pick=__name(key=>input[key],"pick");return pick("a")+pick("b")}', true, { a: 2, b: 40 }))
      .resolves.toBe(42);
  });

  it('gives the wrapped binding the name esbuild kept', async () => {
    await expect(run('() => __name(() => 1, "pick").name', false)).resolves.toBe('pick');
  });

  it.each([
    ['document.title', 'Cart'],
    ['(() => document.title)()', 'Cart'],
    ['Promise.resolve(document.title)', 'Cart'],
    ['() => document.title', 'Cart'],
  ])('evaluates a string as an expression, calling a function it evaluates to: %s', async (source, value) => {
    vi.stubGlobal('document', { title: 'Cart' });
    await expect(run(source, false)).resolves.toBe(value);
  });

  it('leaves a page global of any name visible to the source', async () => {
    vi.stubGlobal('result', 'page value');
    vi.stubGlobal('value', 'page value');
    await expect(run('[result, value]', false)).resolves.toEqual(['page value', 'page value']);
  });

  it('calls a function expression with the argument', async () => {
    await expect(run('(n) => n + 1', true, 41)).resolves.toBe(42);
  });

  it('reports an exception from the evaluated code by message', async () => {
    await expect(run('() => { throw new Error("boom"); }', false)).rejects.toMatchObject({ code: 'EVALUATE_FAILED', message: 'boom' });
  });

  it('reports a result that is not JSON by why', async () => {
    await expect(run('() => [1, undefined]', false)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'evaluate result must be JSON-safe, found undefined',
    });
  });

  it('calls a function on the element first, then the argument', async () => {
    const element = { isConnected: true, matches: () => false, id: 'nav' };
    const evaluate = compileEvaluation('(el, suffix) => el.id + suffix', ['element', 'arg'], { awaitResult: true });
    expect(decode(await evaluate(element, '-main'))).toBe('nav-main');
  });

  it('reads a result that is not JSON as a value, which only the throwing form refuses', async () => {
    const report = await compileEvaluation('(el) => el', ['element', 'arg'], { awaitResult: true })({ isConnected: true, matches: () => false, run: () => 1 });
    expect(readEvaluation(report)).toEqual({ ok: false, invalid: expect.stringContaining('must be JSON-safe') });
    expect(() => decode(report)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('reports a detached element as a retryable stale node without running the source', async () => {
    const ran = vi.fn();
    vi.stubGlobal('ran', ran);
    const report = await compileEvaluation('() => ran()', ['element', 'arg'], { awaitResult: true })({ isConnected: false }, undefined);
    expect(() => readEvaluation(report)).toThrow(expect.objectContaining({ code: 'NODE_STALE', retryable: true }));
    expect(ran).not.toHaveBeenCalled();
  });

  it.each([
    ['a password field', () => true],
    ['an element whose matches throws', () => { throw new Error('replaced'); }],
    ['an element whose matches answers no boolean', () => undefined],
  ])('refuses %s as POLICY_DENIED without running the source', async (_, matches) => {
    const ran = vi.fn();
    vi.stubGlobal('ran', ran);
    const selectors: unknown[] = [];
    const element = { isConnected: true, matches: (selector: unknown) => { selectors.push(selector); return matches(); } };
    const report = await compileEvaluation('() => ran()', ['element', 'arg'], { awaitResult: true })(element, undefined);
    expect(() => readEvaluation(report)).toThrow(
      expect.objectContaining({
        code: 'POLICY_DENIED',
        category: 'configuration',
        message: 'reading values from a secure field is denied: the element is one now but was not when located, or its type cannot be checked',
      }),
    );
    expect(ran).not.toHaveBeenCalled();
    expect(selectors).toEqual([SECURE_FIELD_SELECTOR]);
  });

  it('leaves page globals named like its own bindings in reach of the source', async () => {
    vi.stubGlobal('secure', 'page-secure');
    vi.stubGlobal('element', 'page-element');
    vi.stubGlobal('arg', 'page-arg');
    const report = await compileEvaluation('() => [secure, element, arg]', ['element', 'arg'], { awaitResult: true })(
      { isConnected: true, matches: () => false },
      'passed',
    );
    expect(readEvaluation(report)).toEqual({ ok: true, value: ['page-secure', 'page-element', 'page-arg'] });
  });

  it('waits for a promise the source returns, by default', async () => {
    const report = await compileEvaluation('() => Promise.resolve(7)', [], { awaitResult: true })();
    expect(readEvaluation(report)).toEqual({ ok: true, value: 7 });
  });

  describe('without awaitResult', () => {
    /** Runs the boundary on an element with `awaitResult` off; it must answer synchronously. */
    const readSync = (source: string): ReturnType<typeof readEvaluation> => {
      const report = compileEvaluation(source, ['element', 'arg'], { awaitResult: false })({ isConnected: true, matches: () => false });
      expect(typeof report).toBe('string');
      return readEvaluation(report as string);
    };
    const notJson = { ok: false, invalid: expect.stringContaining('must be JSON-safe') };

    it('reports a settled promise as a value that is not JSON', () => {
      vi.stubGlobal('settled', Promise.resolve(7));
      expect(readSync('() => settled')).toEqual(notJson);
    });

    it('reports a thenable as a value that is not JSON, and never calls its then', () => {
      const then = vi.fn();
      // oxlint-disable-next-line unicorn/no-thenable -- the boundary must not adopt a thenable
      vi.stubGlobal('thenable', { then });
      expect(readSync('() => thenable')).toEqual(notJson);
      expect(then).not.toHaveBeenCalled();
    });

    it('reports a non-enumerable thenable as a value that is not JSON, while keeping a non-callable then property', () => {
      const then = vi.fn();
      const hidden = { ready: true };
      // oxlint-disable-next-line unicorn/no-thenable -- tests a non-enumerable thenable without awaiting it
      Object.defineProperty(hidden, 'then', { value: then });
      vi.stubGlobal('hiddenThenable', hidden);
      expect(readSync('() => hiddenThenable')).toEqual(notJson);
      expect(then).not.toHaveBeenCalled();

      // oxlint-disable-next-line unicorn/no-thenable -- verifies non-callable then stays ordinary JSON
      expect(readSync('() => ({ ready: true, then: 1 })')).toEqual({ ok: true, value: { ready: true, then: 1 } });
    });

    it('reports a pending promise as a value that is not JSON, at once', () => {
      vi.stubGlobal('pending', new Promise(() => undefined));
      expect(readSync('() => pending')).toEqual(notJson);
    });

    it('reports a rejected promise as a value that is not JSON, not as a throw', () => {
      const rejected = Promise.reject(new Error('rejected'));
      rejected.catch(() => undefined);
      vi.stubGlobal('rejected', rejected);
      expect(readSync('() => rejected')).toEqual(notJson);
    });

    it('reads JSON, null, and undefined as they are', () => {
      expect(readSync('(el, arg) => ({ a: [1, "x", null] })')).toEqual({ ok: true, value: { a: [1, 'x', null] } });
      expect(readSync('() => null')).toEqual({ ok: true, value: null });
      expect(readSync('() => undefined')).toEqual({ ok: true, value: undefined });
    });

    it('reports a synchronous throw as EVALUATE_FAILED', () => {
      expect(() => readSync('() => { throw new Error("boom"); }')).toThrow(
        expect.objectContaining({ code: 'EVALUATE_FAILED', message: 'boom' }),
      );
    });
  });
});

describe('pageValueEncoder', () => {
  const encodePageValue = pageValueEncoder();

  it.each([
    [{ a: [1, 'b', null, true], c: { d: -1.5 } }],
    ['tab\t "quoted" \\ \u0000 \u2028 \ud83d\ude00'],
    [[]],
    [{}],
  ])('encodes JSON text that parses back to the value: %j', (value) => {
    expect(JSON.parse(encodePageValue(value)!)).toEqual(value);
  });

  it('keeps a lone surrogate', () => {
    expect(JSON.parse(encodePageValue('\ud800')!)).toBe('\ud800');
  });

  it.each([
    ['NaN', Number.NaN, 'contains a non-finite number'],
    ['a Date', { when: new Date(0) }, 'must be JSON-safe'],
    ['a Map', [new Map()], 'must be JSON-safe'],
    ['an object with toJSON', new (class { toJSON() { return 1; } })(), 'must be JSON-safe'],
    ['a bigint', { id: 1n }, 'must be JSON-safe, found bigint'],
    ['a symbol', [Symbol('x')], 'must be JSON-safe, found symbol'],
    ['an undefined member', { missing: undefined }, 'must be JSON-safe, found undefined'],
    ['a function', () => 1, 'must be JSON-safe, found function'],
  ])('rejects %s', (_label, value, invalid) => {
    expect(() => encodePageValue(value)).toThrow(expect.objectContaining({ invalid }));
  });

  it('rejects a cycle but not a shared object', () => {
    const shared = { sku: 'a' };
    expect(encodePageValue([shared, shared])).toBe('[{"sku":"a"},{"sku":"a"}]');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodePageValue(cyclic)).toThrow(expect.objectContaining({ invalid: 'contains a cycle' }));
  });

  it('encodes a null-prototype object', () => {
    expect(encodePageValue(Object.assign(Object.create(null), { sku: 'a' }))).toBe('{"sku":"a"}');
  });

  it('returns no text for an undefined root', () => {
    expect(encodePageValue(undefined)).toBeUndefined();
  });
});

// The same boundary browser.evaluate and init scripts use for serialized functions.
describe('pageFunctionSource', () => {
  it('evaluates an ordinary method with its argument', async () => {
    const functions = { add(value: number) { return value + 1; } };
    await expect(run(pageFunctionSource(functions.add), true, 41)).resolves.toBe(42);
  });

  it('evaluates an async method with its argument', async () => {
    const functions = { async add(value: number) { return value + 1; } };
    await expect(run(pageFunctionSource(functions.add), true, 41)).resolves.toBe(42);
  });
});
