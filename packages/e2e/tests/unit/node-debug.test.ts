import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeDebugWarning } from '../../src/run/node-debug.ts';

const prints = (...on: string[]) => (section: string): boolean => on.includes(section);

describe('the NODE_DEBUG warning', () => {
  it('says nothing without the variable, whatever Node prints', () => {
    expect(nodeDebugWarning(undefined, prints('child_process', 'net'))).toBeUndefined();
  });

  it('says nothing when no section that prints credentials is on', () => {
    expect(nodeDebugWarning('http,fetch', prints('http', 'fetch'))).toBeUndefined();
    expect(nodeDebugWarning('', prints())).toBeUndefined();
  });

  it('names the variable as set and the environment for child_process', () => {
    expect(nodeDebugWarning('CHILD*', prints('child_process'))).toBe(
      'e2e: NODE_DEBUG=CHILD* makes Node print the environment of every process e2e starts; e2e redacts its secrets and the provider keys it knows there, and every other token or password is printed as it is, so unset NODE_DEBUG unless you are debugging with it',
    );
  });

  it('names the request headers for net', () => {
    expect(nodeDebugWarning('net', prints('net'))).toBe(
      'e2e: NODE_DEBUG=net makes Node print the headers of requests made with node:http; e2e redacts its secrets and the provider keys it knows there, and every other token or password is printed as it is, so unset NODE_DEBUG unless you are debugging with it',
    );
  });

  it('names both when both are on', () => {
    expect(nodeDebugWarning('*', prints('child_process', 'net', 'http'))).toContain(
      'makes Node print the environment of every process e2e starts and the headers of requests made with node:http; e2e redacts',
    );
  });
});

describe('warning of NODE_DEBUG', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes the warning to stderr once, however many runs the process starts', async () => {
    vi.resetModules();
    const fresh = await import('../../src/run/node-debug.ts');
    vi.stubEnv('NODE_DEBUG', 'child_process');
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    fresh.warnOfNodeDebug(prints('child_process'));
    fresh.warnOfNodeDebug(prints('child_process'));
    expect(written).toEqual([`${fresh.nodeDebugWarning('child_process', prints('child_process'))}\n`]);
  });

  it('writes nothing when Node prints no credentials', async () => {
    vi.resetModules();
    const fresh = await import('../../src/run/node-debug.ts');
    vi.stubEnv('NODE_DEBUG', 'http');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fresh.warnOfNodeDebug(prints());
    expect(write).not.toHaveBeenCalled();
  });
});
