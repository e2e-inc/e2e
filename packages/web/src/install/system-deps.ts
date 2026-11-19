/**
 * The system packages the browsers load on Debian and Ubuntu, which
 * `e2e-web install --with-deps` installs with apt.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { InfrastructureError } from '@e2e-dev/core/engine';
import type { BrowserName } from '../browsers.ts';
import { cancelledCheck } from './lock.ts';

/** The fonts a headless browser renders with on a minimal Debian or Ubuntu image; each one the distribution lacks is left out. */
const APT_TOOLS = ['fonts-noto-color-emoji', 'fonts-unifont', 'libfontconfig1', 'libfreetype6', 'xfonts-cyrillic', 'xfonts-scalable', 'fonts-liberation', 'fonts-ipafont-gothic', 'fonts-wqy-zenhei', 'fonts-tlwg-loma-otf', 'fonts-freefont-ttf'];

/** The Debian packages each browser loads, by their Ubuntu 24.04 names. */
const APT_PACKAGES: Readonly<Record<BrowserName, readonly string[]>> = {
  chromium: [
    'libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libatspi2.0-0t64', 'libcairo2', 'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libgbm1',
    'libglib2.0-0t64', 'libnspr4', 'libnss3', 'libpango-1.0-0', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3',
    'libxkbcommon0', 'libxrandr2',
  ],
  firefox: [
    'libasound2t64', 'libatk1.0-0t64', 'libcairo-gobject2', 'libcairo2', 'libdbus-1-3', 'libfontconfig1', 'libfreetype6', 'libgdk-pixbuf-2.0-0',
    'libglib2.0-0t64', 'libgtk-3-0t64', 'libpango-1.0-0', 'libpangocairo-1.0-0', 'libx11-6', 'libx11-xcb1', 'libxcb-shm0', 'libxcb1', 'libxcomposite1',
    'libxcursor1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxi6', 'libxrandr2', 'libxrender1', 'xz-utils',
  ],
};

/**
 * Runs `file` to completion and resolves to its exit code, null when it
 * could not start or a signal ended it. It never blocks the event loop, so
 * the signal that cancels the install is heard while it runs.
 */
function run(file: string, args: readonly string[], stdio: 'inherit' | 'ignore'): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
    child.once('error', () => resolve(null));
    child.once('exit', resolve);
  });
}

/**
 * Installs the system packages `names` load, with apt on Debian and Ubuntu
 * (as root, else through sudo); elsewhere there is nothing to do. A package
 * Ubuntu 24.04 renamed with a `t64` suffix also takes its older name, and a
 * font the distribution does not carry is skipped. Once `signal` aborted no
 * further command starts and it throws `CANCELLED`; the one running is left
 * to finish, since apt killed halfway leaves packages unconfigured. It needs
 * no install lock: apt's state is the machine's, not the cache's, and apt
 * locks it itself.
 */
export async function installSystemDeps(names: readonly BrowserName[], log: (line: string) => void, signal: AbortSignal): Promise<void> {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/apt-get')) return;
  const root = process.getuid?.() === 0;
  const apt = (args: readonly string[]) => (root ? run('apt-get', args, 'inherit') : run('sudo', ['apt-get', ...args], 'inherit'));
  cancelledCheck(signal);
  if ((await apt(['update'])) !== 0) throw new InfrastructureError('BROWSER_INSTALL_FAILED', 'apt-get update failed');
  const fonts: string[] = [];
  for (const name of APT_TOOLS) {
    cancelledCheck(signal);
    if ((await run('apt-get', ['install', '--simulate', '--no-install-recommends', name], 'ignore')) === 0) fonts.push(name);
  }
  cancelledCheck(signal);
  const packages = [...new Set([...fonts, ...names.flatMap((name) => APT_PACKAGES[name])])];
  const wanted = packages.map((name) => (name.endsWith('t64') ? `${name} | ${name.slice(0, -3)}` : name)).join(', ');
  log(`Installing system packages: ${packages.join(' ')}`);
  if ((await apt(['satisfy', '-y', '--no-install-recommends', wanted])) !== 0) {
    throw new InfrastructureError('BROWSER_INSTALL_FAILED', 'apt-get could not install the browsers\' system packages');
  }
}
