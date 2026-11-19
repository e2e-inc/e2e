/**
 * `AttemptDownloads.save`: a wait saves every download or none. A provider
 * read that fails or outlives the budget, and a trigger that returns after
 * the budget ran out, leave nothing in the attempt's `downloads` folder,
 * where a file no step attached is never redacted.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactPaths } from '../../src/driver/artifact-paths.ts';
import { AttemptDownloads, type RemoteDownloads } from '../../src/driver/downloads.ts';
import { FakeBidi, navigationInfo, settle } from '../helpers/bidi-fake.ts';
import { gate } from '../helpers/gate.ts';

describe('AttemptDownloads.save', () => {
  let artifactsDir: string;
  let fake: FakeBidi;
  let local: AttemptDownloads | undefined;

  beforeEach(() => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-attempt-downloads-'));
    fake = new FakeBidi();
    local = undefined;
  });

  afterEach(() => {
    local?.dispose();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** The attempt's downloads over the fake browser, whose every context is the attempt's tab. */
  const attemptDownloads = (remote?: RemoteDownloads): AttemptDownloads => new AttemptDownloads(fake.connection, remote, new ArtifactPaths(artifactsDir), () => true);

  /** The files in the attempt's `downloads` folder. */
  const kept = (): string[] => {
    const folder = path.join(artifactsDir, 'downloads');
    return existsSync(folder) ? readdirSync(folder) : [];
  };

  /** The browser starts and completes one download of `name`, saved at `filepath` on its disk. */
  const download = (name: string, filepath: string): void => {
    const navigation = navigationInfo('tab', `http://app.test/${name}`);
    fake.emit('browsingContext.downloadWillBegin', { ...navigation, download: name, suggestedFilename: name });
    fake.emit('browsingContext.downloadEnd', { ...navigation, download: name, status: 'complete', filepath });
  };

  const budget = (timeoutMs: number) => ({ timeoutMs, signal: new AbortController().signal });

  it('copies each finished download into the downloads folder, in start order', async () => {
    local = attemptDownloads();
    const { dir } = local;
    const saved = await local.save(2, async () => {
      for (const name of ['a.txt', 'b.txt']) {
        writeFileSync(path.join(dir, name), `body of ${name}`);
        download(name, path.join(dir, name));
      }
    }, budget(1_000));
    expect(saved.map((file) => file.path)).toEqual(['downloads/001-a.txt', 'downloads/002-b.txt']);
    expect(saved.map((file) => readFileSync(file.absolutePath, 'utf8'))).toEqual(['body of a.txt', 'body of b.txt']);
  });

  it('keeps none of a wait whose second download cannot be written', async () => {
    local = attemptDownloads();
    const { dir } = local;
    const wait = local.save(2, async () => {
      writeFileSync(path.join(dir, 'a.txt'), 'body of a.txt');
      download('a.txt', path.join(dir, 'a.txt'));
      download('b.txt', path.join(dir, 'gone.txt'));
    }, budget(1_000));
    await expect(wait).rejects.toMatchObject({ code: 'ENOENT' });
    expect(kept()).toEqual([]);
  });

  /** A provider that serves no downloads, whose browser saves them wherever it runs. */
  const UNSERVED: RemoteDownloads = { unserved: 'browser provider "toy" serves no downloads' };

  it('saves the download of a provider without downloads whose browser saved it on this machine', async () => {
    local = attemptDownloads(UNSERVED);
    const { dir } = local;
    const saved = await local.save(1, async () => {
      writeFileSync(path.join(dir, 'a.txt'), 'body of a.txt');
      download('a.txt', path.join(dir, 'a.txt'));
    }, budget(1_000));
    expect(saved.map((file) => readFileSync(file.absolutePath, 'utf8'))).toEqual(['body of a.txt']);
  });

  it('refuses, by the provider, a download its browser saved on another machine', async () => {
    local = attemptDownloads(UNSERVED);
    const wait = local.save(1, async () => download('a.txt', '/remote/downloads/a.txt'), budget(1_000));
    await expect(wait).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'download a.txt is not on this machine: browser provider "toy" serves no downloads',
    });
    expect(kept()).toEqual([]);
  });

  it('names the provider when a download it does not serve was canceled', async () => {
    local = attemptDownloads(UNSERVED);
    const wait = local.save(1, async () => {
      const navigation = navigationInfo('tab', 'http://app.test/a.txt');
      fake.emit('browsingContext.downloadWillBegin', { ...navigation, download: 'a.txt', suggestedFilename: 'a.txt' });
      fake.emit('browsingContext.downloadEnd', { ...navigation, download: 'a.txt', status: 'canceled' });
    }, budget(1_000));
    await expect(wait).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'download a.txt was canceled; if the browser runs on another machine: browser provider "toy" serves no downloads',
    });
  });

  it('keeps nothing when its provider fails to read a later download back', async () => {
    const reads: string[] = [];
    const downloads = attemptDownloads({
      provider: 'browser provider "toy"',
      dir: '/remote',
      read: async (file) => {
        reads.push(file);
        if (file === '/remote/b.txt') throw new Error('provider read broke');
        return Buffer.from('served text');
      },
    });
    const waited = downloads.save(2, async () => {
      download('a.txt', '/remote/a.txt');
      download('b.txt', '/remote/b.txt');
    }, budget(1_000));
    await expect(waited).rejects.toThrow('provider read broke');
    expect(reads).toEqual(['/remote/a.txt', '/remote/b.txt']);
    expect(kept()).toEqual([]);
  });

  it.each([
    ['fails once its signal aborts', true],
    ['answers after the budget ran out', false],
  ])('keeps nothing when the read of a later download outlives the budget and %s', async (_name, honorsSignal) => {
    let answer: (bytes: Uint8Array) => void = () => undefined;
    const reads: string[] = [];
    const downloads = attemptDownloads({
      provider: 'browser provider "toy"',
      dir: '/remote',
      read: (file, signal) => {
        reads.push(file);
        if (file === '/remote/a.txt') return Promise.resolve(Buffer.from('served text'));
        return new Promise<Uint8Array>((resolve, reject) => {
          answer = resolve;
          if (honorsSignal) signal.addEventListener('abort', () => reject(new Error('provider read canceled')), { once: true });
        });
      },
    });
    const waited = downloads.save(2, async () => {
      download('a.txt', '/remote/a.txt');
      download('b.txt', '/remote/b.txt');
    }, budget(40));
    await expect(waited).rejects.toThrow('download b.txt did not finish: browser provider "toy" read it back too slowly');
    answer(Buffer.from('late text'));
    await settle();
    expect(reads).toEqual(['/remote/a.txt', '/remote/b.txt']);
    expect(kept()).toEqual([]);
  });

  it('keeps nothing when its trigger returns after the budget ran out, though the download had finished', async () => {
    local = attemptDownloads();
    const filepath = path.join(local.dir, 'report.txt');
    writeFileSync(filepath, 'finished in time');
    const { held: pending, release } = gate();
    const waited = local.save(1, () => {
      download('report.txt', filepath);
      return pending;
    }, budget(40));
    await expect(waited).rejects.toThrow('the download trigger did not resolve within 40ms');
    release();
    await settle();
    expect(kept()).toEqual([]);
  });
});
