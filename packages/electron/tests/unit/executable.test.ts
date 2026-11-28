import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appPathProblem, describeExecutable, ensureElectronBinary, resolveExecutable } from '../../src/executable.ts';

const root = mkdtempSync(path.join(tmpdir(), 'e2e-electron-executable-'));
mkdirSync(path.join(root, 'MyApp.app'));
writeFileSync(path.join(root, 'package.json'), '{}');
// What each platform starts: a script with the execute bit, or on Windows a program image.
writeFileSync(path.join(root, 'run.sh'), process.platform === 'win32' ? 'MZ' : '#!/bin/sh\n');
chmodSync(path.join(root, 'run.sh'), 0o755);

afterAll(() => rmSync(root, { recursive: true, force: true }));

// What the developer running the tests has set, which no test may change.
const ambientOverride = process.env['ELECTRON_OVERRIDE_DIST_PATH'];

describe('the project\'s electron package', () => {
  it('starts the binary ELECTRON_OVERRIDE_DIST_PATH names, as Electron\'s own index.js does', async () => {
    const project = path.join(root, 'project');
    const electron = path.join(project, 'node_modules', 'electron');
    const override = path.join(root, 'custom-dist');
    mkdirSync(electron, { recursive: true });
    mkdirSync(override, { recursive: true });
    writeFileSync(path.join(project, 'package.json'), '{}');
    writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '45.5.0', main: 'index.js' }));
    writeFileSync(path.join(electron, 'index.js'), '');
    writeFileSync(path.join(override, 'electron'), '');
    expect(describeExecutable(project, undefined, {}).status).toBe('warn');
    // The run's environment, which a host may hand a worker other than this process's own.
    const env = { ELECTRON_OVERRIDE_DIST_PATH: override };
    expect(resolveExecutable(project, undefined, env)).toBe(path.join(override, 'electron'));
    expect(describeExecutable(project, undefined, env).status).toBe('pass');
    // Read from the environment it is given, never this process's, whatever this process has.
    expect(process.env['ELECTRON_OVERRIDE_DIST_PATH']).toBe(ambientOverride);
  });

  it('names the variable, and downloads nothing, when ELECTRON_OVERRIDE_DIST_PATH points where no binary is', async () => {
    const project = path.join(root, 'project');
    const env = { ELECTRON_OVERRIDE_DIST_PATH: path.join(root, 'nowhere') };
    expect(() => resolveExecutable(project, undefined, env)).toThrow(/ELECTRON_OVERRIDE_DIST_PATH/);
    await expect(ensureElectronBinary(project, undefined, env, () => undefined, new AbortController().signal)).rejects.toThrow(/ELECTRON_OVERRIDE_DIST_PATH/);
    expect(describeExecutable(project, undefined, env)).toMatchObject({ status: 'fail', message: expect.stringContaining('ELECTRON_OVERRIDE_DIST_PATH') });
  });
});

describe('app.appPath', () => {
  it('takes a main script, or a directory whose main script exists, and says what is wrong otherwise', () => {
    const app = path.join(root, 'app');
    mkdirSync(path.join(app, 'no-main'), { recursive: true });
    writeFileSync(path.join(app, 'main.cjs'), '');
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
    writeFileSync(path.join(app, 'no-main', 'package.json'), '{}');
    expect(appPathProblem(root, 'app')).toBeUndefined();
    expect(appPathProblem(root, 'app/main.cjs')).toBeUndefined();
    expect(appPathProblem(root, 'missing')).toMatch(/does not exist/);
    expect(appPathProblem(root, 'app/no-main')).toMatch(/index\.js does not exist/);
  });
});

describe('executablePath', () => {
  it('starts a regular file it may execute', async () => {
    expect(resolveExecutable(root, 'run.sh', {})).toBe(path.join(root, 'run.sh'));
    expect(describeExecutable(root, 'run.sh', {}).status).toBe('pass');
  });

  it('refuses a directory, such as an .app bundle, and a file it may not execute, in doctor as at launch', async () => {
    // Windows starts only a program image, which package.json is not, so it is refused on every platform.
    for (const name of ['MyApp.app', 'package.json', 'missing']) {
      expect(() => resolveExecutable(root, name, {})).toThrow(/not an executable file/);
      expect(describeExecutable(root, name, {})).toMatchObject({ status: 'fail', message: expect.stringContaining('not an executable file') });
    }
    expect(() => resolveExecutable(root, 'MyApp.app', {})).toThrow(path.join(root, 'MyApp.app', 'Contents', 'MacOS', 'MyApp'));
    // Checked once in prepare, so a wrong path is one error for the run.
    await expect(ensureElectronBinary(root, 'missing', {}, () => undefined, new AbortController().signal)).rejects.toThrow(/not an executable file/);
  });

  it('starts only a program image on Windows, and names the file to start for a shortcut, a folder, and a missing extension', () => {
    const install = path.join(root, 'install');
    mkdirSync(install);
    writeFileSync(path.join(install, 'MyApp.exe'), 'MZ\u0090');
    writeFileSync(path.join(install, 'Uninstall MyApp.exe'), 'MZ\u0090');
    writeFileSync(path.join(install, 'MyApp.lnk'), 'L\u0000');
    writeFileSync(path.join(install, 'start.cmd'), '@echo off');
    const problem = (name: string): string => describeExecutable(install, name, {}, 'win32').message;
    expect(resolveExecutable(install, 'MyApp.exe', {}, 'win32')).toBe(path.join(install, 'MyApp.exe'));
    expect(problem('MyApp.lnk')).toMatch(/not an executable file; it is a shortcut: name the \.exe it points to/);
    expect(problem('start.cmd')).toMatch(/not an executable file$/);
    expect(problem('MyApp')).toContain(`name the file with its extension, ${path.join(install, 'MyApp.exe')}`);
    expect(problem('.')).toContain('name the app\'s .exe inside the folder (it holds MyApp.exe, Uninstall MyApp.exe)');
    expect(() => resolveExecutable(install, 'MyApp.lnk', {}, 'win32')).toThrow(/shortcut/);
  });

  it('refuses the launcher a Squirrel installer leaves beside the app, and names the app it starts', () => {
    const install = path.join(root, 'squirrel');
    for (const folder of ['app-3.7.1', 'packages']) mkdirSync(path.join(install, folder), { recursive: true });
    for (const file of ['MyApp.exe', 'Update.exe', path.join('app-3.7.1', 'MyApp.exe')]) writeFileSync(path.join(install, file), 'MZ\u0090');
    const app = path.join(install, 'app-3.7.1', 'MyApp.exe');
    const problem = (name: string): string => describeExecutable(install, name, {}, 'win32').message;
    expect(describeExecutable(install, 'MyApp.exe', {}, 'win32')).toEqual({ status: 'fail', message: expect.stringContaining(`name the app itself, ${app}`) });
    expect(resolveExecutable(install, path.join('app-3.7.1', 'MyApp.exe'), {}, 'win32')).toBe(app);
    // The hints for a folder and a missing extension skip the launcher too.
    expect(problem('.')).toContain(`name the app's .exe, ${app}`);
    expect(problem('MyApp')).toContain(`name the file with its extension, ${app}`);
    // The updater is a program of its own, with no app of its name in the version folders.
    expect(resolveExecutable(install, 'Update.exe', {}, 'win32')).toBe(path.join(install, 'Update.exe'));
    // With an update staged beside the running version, which one the launcher starts is its own rule: both are named.
    mkdirSync(path.join(install, 'app-3.10.0-beta'));
    writeFileSync(path.join(install, 'app-3.10.0-beta', 'MyApp.exe'), 'MZ\u0090');
    expect(problem('MyApp.exe')).toContain('name the app itself, MyApp.exe in one of the version folders beside it (app-3.10.0-beta, app-3.7.1)');
  });
});
