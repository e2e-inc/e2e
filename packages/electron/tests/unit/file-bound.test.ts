import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { appDirectory, outsideApp } from '../../src/file-bound.ts';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-electron-bound-')));
const app = path.join(root, 'app');
mkdirSync(path.join(app, 'renderer'), { recursive: true });
writeFileSync(path.join(app, 'main.js'), '');
writeFileSync(path.join(app, 'package.json'), '{}');
mkdirSync(path.join(app, 'out', 'main'), { recursive: true });
writeFileSync(path.join(app, 'out', 'main', 'index.js'), '');
// What a build that emits CommonJS from a module project writes beside its output.
writeFileSync(path.join(app, 'out', 'main', 'package.json'), '{"type":"commonjs"}');
writeFileSync(path.join(app, 'renderer', 'index.html'), '');
writeFileSync(path.join(root, 'secret.txt'), '');
const page = pathToFileURL(path.join(app, 'renderer', 'index.html')).href;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('appDirectory', () => {
  it('is what the main process reports, else the declared app path, else where the first local page is', () => {
    expect(appDirectory({ reported: app, declared: '/elsewhere', firstDocument: page, projectRoot: app })).toBe(app);
    expect(appDirectory({ reported: undefined, declared: app, firstDocument: page, projectRoot: app })).toBe(app);
    expect(appDirectory({ reported: undefined, declared: path.join(app, 'main.js'), firstDocument: page, projectRoot: app })).toBe(app);
    expect(appDirectory({ reported: undefined, declared: undefined, firstDocument: page, projectRoot: app })).toBe(path.join(app, 'renderer'));
  });

  it('is the package a declared main script is in, past a manifest that only sets the module type, though the main process reports the script\'s own directory', () => {
    const script = path.join(app, 'out', 'main', 'index.js');
    expect(appDirectory({ reported: path.join(app, 'out', 'main'), declared: script, firstDocument: page, projectRoot: app })).toBe(app);
    expect(outsideApp(page, appDirectory({ reported: path.join(app, 'out', 'main'), declared: script, firstDocument: page, projectRoot: app }))).toBeUndefined();
  });

  it('looks for a main script\'s package no higher than the project, whose root may sit under another package', () => {
    // A project with no manifest of its own beside its script, inside a directory that has one (a home directory, a monorepo).
    const project = path.join(app, 'loose');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'main.js'), '');
    expect(appDirectory({ reported: project, declared: path.join(project, 'main.js'), firstDocument: page, projectRoot: project })).toBe(project);
    expect(outsideApp(pathToFileURL(path.join(app, 'main.js')).href, project)).toMatch(/outside it/);
  });

  it('is the archive an app path names, as Electron reports it, not the package it sits in', () => {
    const archive = path.join(app, 'releases', 'app.asar');
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(archive, '');
    expect(appDirectory({ reported: archive, declared: archive, firstDocument: page, projectRoot: app })).toBe(archive);
    expect(outsideApp(page, archive)).toMatch(/outside it/);
  });

  it('is the archive a packaged app shows its first page from, and nothing for an app that shows no local page', () => {
    const archive = path.join(root, 'Resources', 'app.asar');
    expect(appDirectory({ reported: undefined, declared: undefined, firstDocument: pathToFileURL(path.join(archive, 'dist', 'index.html')).href, projectRoot: app })).toBe(archive);
    expect(appDirectory({ reported: undefined, declared: undefined, firstDocument: 'http://localhost:3000/', projectRoot: app })).toBeUndefined();
  });
});

describe('outsideApp', () => {
  it('passes the app\'s own pages and every location that is no local file', () => {
    expect(outsideApp(page, app)).toBeUndefined();
    expect(outsideApp(`${page}?tab=2#top`, app)).toBeUndefined();
    for (const location of ['https://example.com/', 'about:blank', 'data:text/html,hi', 'app://bundle/index.html', '']) expect(outsideApp(location, app), location).toBeUndefined();
  });

  it('refuses a local file outside the app\'s directory, however the path gets there', () => {
    expect(outsideApp(pathToFileURL(path.join(root, 'secret.txt')).href, app)).toMatch(/left the app's directory for file:\/\/.*secret\.txt/);
    expect(outsideApp(pathToFileURL(path.join(app, '..', 'secret.txt')).href, app)).toMatch(/outside it/);
    expect(outsideApp(pathToFileURL(`${app}-sibling/index.html`).href, app)).toMatch(/outside it/);
    symlinkSync(path.join(root, 'secret.txt'), path.join(app, 'link.txt'));
    expect(outsideApp(pathToFileURL(path.join(app, 'link.txt')).href, app)).toMatch(/outside it/);
  });

  it('refuses every local file when the app\'s directory is not known', () => {
    expect(outsideApp(page, undefined)).toMatch(/not known/);
    expect(outsideApp('https://example.com/', undefined)).toBeUndefined();
  });
});
