/**
 * The engine's errors: a gone node, frame, or document is retryable
 * `NODE_STALE`, a classified error passes untouched, anything else is
 * `ENGINE_FAILURE`; what a failure after dispatched input becomes, with a
 * sensitive value scrubbed; the stale fallback, the fallback for an element
 * the browser refused, and the quiet release helper;
 * and a runner error recognized by its code, whichever copy of `e2e` raised
 * it.
 */

import { describe, expect, it } from 'vitest';
import { EngineError, TestError, ConfigurationError } from '@e2e-dev/core/engine';
import { afterDispatch, BidiError, classify, isStale, releaseQuietly, ScriptError, unlessRefused, unlessStale, isTestErrorCode } from '../../src/errors.ts';

describe('classify', () => {
  it.each([
    new BidiError('script.callFunction', 'no such node', 'SharedId "f.1.d_2" was not found.'),
    new BidiError('script.callFunction', 'no such node', 'SharedId "f.1.d.2.e.3" belongs to different document. Current document is 4.'),
    new BidiError('script.callFunction', 'unknown error', 'Node with given id does not belong to the document'),
    new BidiError('browsingContext.getTree', 'no such frame', 'Context abc not found'),
    new BidiError('script.callFunction', 'no such frame', 'Browsing context is gone'),
    new BidiError('script.callFunction', 'unknown error', 'Cannot find context with specified id'),
    new ScriptError('Execution context was destroyed, most likely because of a navigation'),
    new ScriptError('element is detached'),
    new BidiError('script.callFunction', 'unknown error', 'Inspected target navigated or closed'),
  ])('reads a gone node, frame, or document as retryable NODE_STALE: %s', (cause) => {
    const error = classify(cause, 'tap');
    expect(error).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(error.message).toMatch(/^tap: /);
    expect(isStale(cause)).toBe(true);
  });

  it('passes a classified error through untouched', () => {
    const timeout = new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false });
    const invalid = new TestError('INVALID_LOCATOR', 'bad selector');
    expect(classify(timeout, 'locate')).toBe(timeout);
    expect(classify(invalid, 'locate')).toBe(invalid);
  });

  it('reads an error already classified as NODE_STALE as stale, and one classified as anything else as not', () => {
    expect(isStale(new EngineError('NODE_STALE', 'the page changed while its screenshot was masked', { retryable: true }))).toBe(true);
    expect(isStale(new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false }))).toBe(false);
  });

  it('reads any other failure as ENGINE_FAILURE keeping its cause', () => {
    const cause = new BidiError('browsingContext.navigate', 'unknown error', 'net::ERR_CONNECTION_REFUSED');
    const error = classify(cause, 'navigation');
    expect(error).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(error.cause).toBe(cause);
    expect(isStale(new BidiError('browsingContext.navigate', 'unknown error', 'net::ERR_NAME_NOT_RESOLVED'))).toBe(false);
    expect(classify(new Error('boom'), 'observe')).toMatchObject({ code: 'ENGINE_FAILURE', message: 'observe: boom' });
    expect(isStale(new Error('boom'))).toBe(false);
  });
});

describe('unlessStale', () => {
  it('falls back only for a gone node or document', async () => {
    await expect(unlessStale(Promise.reject(new BidiError('m', 'no such node', '')), 'fallback')).resolves.toBe('fallback');
    await expect(unlessStale(Promise.resolve('value'), 'fallback')).resolves.toBe('value');
    await expect(unlessStale(Promise.reject(new BidiError('m', 'invalid argument', '')), 'fallback')).rejects.toBeInstanceOf(BidiError);
  });
});

describe('unlessRefused', () => {
  it('falls back only for an element the browser refused, never for a frame or document gone under the call', async () => {
    await expect(unlessRefused(Promise.resolve('value'), 'fallback')).resolves.toBe('value');
    for (const refused of [
      new BidiError('script.callFunction', 'no such node', 'SharedId "f.1.d.2.e.3" belongs to different document. Current document is 4.'),
      new BidiError('script.callFunction', 'no such node', 'the node is of a document its browsing context no longer shows'),
      new BidiError('script.callFunction', 'unknown error', 'Node with given id does not belong to the document'),
    ]) {
      await expect(unlessRefused(Promise.reject(refused), 'fallback')).resolves.toBe('fallback');
    }
    for (const gone of [
      new BidiError('script.callFunction', 'no such frame', 'Browsing context is gone'),
      new BidiError('script.callFunction', 'no such frame', 'Context 046C34E7A7D4F228602F3B47BEDF8F34 not found'),
      new BidiError('script.callFunction', 'unknown error', 'Cannot find context with specified id'),
      new BidiError('script.callFunction', 'unknown error', 'Inspected target navigated or closed'),
      new ScriptError('Execution context was destroyed, most likely because of a navigation'),
    ]) {
      await expect(unlessRefused(Promise.reject(gone), 'fallback')).rejects.toBe(gone);
    }
  });
});

describe('releaseQuietly', () => {
  it('settles whatever the release does', async () => {
    await expect(releaseQuietly(Promise.reject(new Error('already gone')))).resolves.toBeUndefined();
    await expect(releaseQuietly(undefined)).resolves.toBeUndefined();
  });
});

describe('afterDispatch', () => {
  const stale = new EngineError('NODE_STALE', 'fill: no such node', { retryable: true });

  it('passes a failure before any input went out through untouched', () => {
    expect(afterDispatch(stale, 'fill', false)).toBe(stale);
  });

  it('leaves it uncertain whether the app took input that went out, keeping the failure as the cause', () => {
    const error = afterDispatch(stale, 'fill', true);
    expect(error).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false, cause: stale });
    expect(error.message).toBe('fill failed after its input was dispatched: fill: no such node');
  });

  it('keeps a failure the app decided as it is once input went out', () => {
    const refused = new TestError('ACTION_FAILED', 'element is not editable');
    expect(afterDispatch(refused, 'fill', true)).toBe(refused);
  });

  it.each([
    new EngineError('NODE_STALE', 'fill "hunter2": no such node', { retryable: true, cause: new ScriptError('hunter2') }),
    new TestError('ACTION_FAILED', 'cannot fill "hunter2"', { cause: new ScriptError('hunter2') }),
  ])('scrubs a sensitive value from the message and drops the cause, keeping the class and code: $code', (raw) => {
    const error = afterDispatch(raw, 'fill', false, 'hunter2');
    expect(error.constructor).toBe(raw.constructor);
    expect(error).toMatchObject({ code: raw.code, retryable: raw.retryable });
    expect(error.message).toBe(raw.message.replace('hunter2', '[redacted]'));
    expect(error.cause).toBeUndefined();
  });

  it('scrubs the value from an uncertain failure too, and attaches no cause', () => {
    const error = afterDispatch(new EngineError('OPERATION_TIMEOUT', 'fill "hunter2" timed out', { retryable: false }), 'fill', true, 'hunter2');
    expect(error).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', message: 'fill failed after its input was dispatched: fill "[redacted]" timed out' });
    expect(error.cause).toBeUndefined();
  });

  it('keeps the failure of a sensitive fill of an empty value as it is', () => {
    const refused = new TestError('ACTION_FAILED', 'element is not editable');
    expect(afterDispatch(refused, 'fill', false, '')).toBe(refused);
  });
});

/** A runner error the way it arrives from a copy of `e2e` this module never imported. */
function foreignTestError(code: string): Error {
  const error = new Error(code);
  error.name = 'TestError';
  Object.assign(error, { category: 'test', code, retryable: false });
  return error;
}

describe('isTestErrorCode', () => {
  it('matches the code on a TestError from this module copy', () => {
    expect(isTestErrorCode(new TestError('LOCATOR_NOT_FOUND', 'gone'), 'LOCATOR_NOT_FOUND')).toBe(true);
    expect(isTestErrorCode(new TestError('LOCATOR_AMBIGUOUS', 'two'), 'LOCATOR_NOT_FOUND')).toBe(false);
  });

  it('matches the code on a TestError from another module copy, where instanceof says no', () => {
    const foreign = foreignTestError('LOCATOR_NOT_FOUND');
    expect(foreign instanceof TestError).toBe(false);
    expect(isTestErrorCode(foreign, 'LOCATOR_NOT_FOUND')).toBe(true);
    expect(isTestErrorCode(foreign, 'LOCATOR_AMBIGUOUS')).toBe(false);
  });

  it('never matches another class carrying the same code', () => {
    const engine = new EngineError('NODE_STALE', 'engine says', { retryable: true });
    expect(isTestErrorCode(engine, 'NODE_STALE')).toBe(false);
    expect(isTestErrorCode(new ConfigurationError('LOCATOR_NOT_FOUND', 'config says'), 'LOCATOR_NOT_FOUND')).toBe(false);
    expect(isTestErrorCode('LOCATOR_NOT_FOUND', 'LOCATOR_NOT_FOUND')).toBe(false);
  });
});
