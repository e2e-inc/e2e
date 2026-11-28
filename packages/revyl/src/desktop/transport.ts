/**
 * The engine transport to a Revyl Mac: the run's connection leases the
 * computer, creating one or starting the persistent one the config names,
 * and sets it up for the engine. Each worker reaches the same computer
 * through the variables `prepare` hands it. Every connection is a session
 * of the relay on the Mac.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { EngineTransport, TransportConnection, TransportContext } from 'e2e/engine';
import { revylCredentials } from '../credentials.ts';
import { forget, prune, remember, remembered, runs } from '../ledger.ts';
import { RevylComputerClient } from './client.ts';
import { ComputerRelay, type RelayCommand } from './exchange.ts';

/** Variables `prepare`'s answer hands each worker: the computer, and where the uploaded app is on it. */
const COMPUTER_ENV = 'E2E_REVYL_COMPUTER';
const APP_ENV = 'E2E_REVYL_APP';

/** Where everything lives on the Mac: under the exec workspace, which is the `computer` user's home for commands. */
const ROOT = '/Users/computer/workspace/.e2e-revyl';
const SOCKET = `${ROOT}/relay.sock`;
const NODE = `${ROOT}/node`;
const AGENT = 'dev.e2e.revyl.relay';
/** The scripts copied to the Mac: TypeScript from the sources, which Node runs as is, or the JavaScript built from them. */
const EXTENSION = path.extname(fileURLToPath(import.meta.url));
const SCRIPTS = ['frames', 'relay', 'server', 'wire'] as const;
/** Bytes Revyl writes in one file operation. */
const WRITE_CHUNK = 65_536;
const SETUP_TIMEOUT_MS = 600_000;
const STOP_TIMEOUT_MS = 330_000;

/** This process's markers in the ledger, under the runner's pid: a later run stops what a runner that died left, once that pid is gone. */
const RUN = `mac-${process.pid}`;
const LEDGER_TARGET = 'desktop';

export interface ComputerOptions {
  /** A persistent computer to run on, instead of a new one per run. */
  readonly computer: string | undefined;
  readonly lifetimeSeconds: number;
  /** The engine packages npm installs on the Mac, pinned to the versions the runner has. */
  readonly packages: readonly string[];
}

/** An app build as it travels to the Mac: its bundle path here, its gzipped tar, and the tar's hash that names it there. */
interface Build {
  readonly bundle: string;
  readonly data: Buffer;
  readonly sha: string;
}

interface Lease {
  readonly id: string;
  release(): Promise<void>;
}

/** One relay per computer in this process, so its sessions share one exchange loop. */
const relays = new Map<string, ComputerRelay>();

export function computerTransport(options: ComputerOptions): EngineTransport {
  const dir = `${ROOT}/${options.packages.join('_').replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const command: RelayCommand = { node: NODE, script: `${dir}/relay${EXTENSION}`, socket: SOCKET };
  return {
    label: 'a Revyl Mac computer',
    async open(context: TransportContext): Promise<TransportConnection> {
      const client = new RevylComputerClient(revylCredentials(context.env));
      if (context.role === 'worker') {
        const id = context.env[COMPUTER_ENV];
        if (id === undefined) throw new Error(`no Revyl computer for this worker: the run's prepare hands one to each worker in ${COMPUTER_ENV}`);
        const app = context.env[APP_ENV];
        return relayFor(id, client, command).open({ [COMPUTER_ENV]: id, ...(app === undefined ? {} : { [APP_ENV]: app }) });
      }
      // Archived first, so a build that cannot be read fails before a computer is leased.
      const build = context.app?.appPath === undefined ? undefined : await archive(path.resolve(context.cwd, context.app.appPath), context.signal);
      const lease = await acquire(client, options, context.signal);
      try {
        const app = await setUp(client, lease.id, dir, options.packages, build, context.signal);
        const connection = relayFor(lease.id, client, command).open({ [COMPUTER_ENV]: lease.id, ...(app === undefined ? {} : { [APP_ENV]: app }) });
        return {
          input: connection.input,
          output: connection.output,
          diagnostics: () => connection.diagnostics?.() ?? '',
          async close(timeoutMs) {
            try {
              await connection.close(timeoutMs);
            } finally {
              relays.delete(lease.id);
              await lease.release();
            }
          },
        };
      } catch (cause) {
        await lease.release().catch(() => undefined);
        throw cause;
      }
    },
  };
}

function relayFor(id: string, client: RevylComputerClient, command: RelayCommand): ComputerRelay {
  let relay = relays.get(id);
  if (relay === undefined) {
    relay = new ComputerRelay(id, client, command);
    relays.set(id, relay);
  }
  return relay;
}

/**
 * The computer this connection runs on. The persistent one the config names
 * is used as it is when it runs, and started and stopped again when it was
 * stopped. Otherwise a new Mac is created and stopped at the end, which
 * deletes it. Each one this run starts is in the ledger until it stopped.
 */
async function acquire(client: RevylComputerClient, options: ComputerOptions, signal: AbortSignal): Promise<Lease> {
  await sweep(client, signal);
  const release = (id: string) => async (): Promise<void> => {
    await client.stop(id, AbortSignal.timeout(STOP_TIMEOUT_MS));
    await forget(RUN, LEDGER_TARGET, id);
    await prune(RUN, LEDGER_TARGET);
  };
  if (options.computer !== undefined) {
    const id = options.computer;
    const state = await client.state(id, signal);
    if (state === 'active') return { id, release: async () => {} };
    if (state === 'starting') {
      await client.waitUntilActive(id, signal);
      return { id, release: async () => {} };
    }
    if (state !== 'stopped') throw new Error(`Revyl computer ${id} is ${state}; run again once it has stopped`);
    await remember(RUN, LEDGER_TARGET, id);
    try {
      await client.start(id, options.lifetimeSeconds, signal);
      await client.waitUntilActive(id, signal);
    } catch (cause) {
      await release(id)().catch(() => undefined);
      throw cause;
    }
    return { id, release: release(id) };
  }
  const id = randomUUID();
  // Recorded before Revyl hears of it, so a runner that dies from here on leaves it to a later run's sweep.
  await remember(RUN, LEDGER_TARGET, id);
  try {
    await client.create(id, options.lifetimeSeconds, signal);
    await client.waitUntilActive(id, signal);
  } catch (cause) {
    await release(id)().catch(() => undefined);
    throw cause;
  }
  return { id, release: release(id) };
}

/** Stops the computers runners that died left in the ledger. A stop that fails keeps its marker for the next run, and never fails this one. */
async function sweep(client: RevylComputerClient, signal: AbortSignal): Promise<void> {
  for (const run of await runs()) {
    const pid = /^mac-(\d+)$/.exec(run)?.[1];
    if (pid === undefined || Number(pid) === process.pid || alive(Number(pid))) continue;
    for (const id of await remembered(run, LEDGER_TARGET)) {
      await client.stop(id, signal).then(
        () => forget(run, LEDGER_TARGET, id),
        () => undefined,
      );
    }
    await prune(run, LEDGER_TARGET);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Readies the computer for the engine and resolves to where the target's
 * app build is on it, when it has one. Copies the relay and server scripts,
 * and the app build unless an earlier run left the same one. npm installs
 * the engine packages once per version. node gets Accessibility and Screen
 * Recording through the TCC database, which the image leaves writable to
 * `sudo`. The relay starts fresh under a LaunchAgent, which ends every
 * server an earlier run left.
 */
async function setUp(client: RevylComputerClient, id: string, dir: string, packages: readonly string[], build: Build | undefined, signal: AbortSignal): Promise<string | undefined> {
  const relative = (file: string): string => path.posix.relative('/Users/computer/workspace', file);
  const present = await shell(client, id, 'mkdir -p "$DIR" && if [ -n "$APP_SHA" ]; then if [ -d "$ROOT/apps/$APP_SHA" ]; then echo present; else rm -rf "$ROOT/apps/$APP_SHA.parts" && mkdir -p "$ROOT/apps/$APP_SHA.parts"; fi; fi', { ROOT, DIR: dir, APP_SHA: build?.sha ?? '' }, signal);
  for (const name of SCRIPTS) {
    await client.writeFile(id, relative(`${dir}/${name}${EXTENSION}`), await readFile(new URL(`./remote/${name}${EXTENSION}`, import.meta.url)), signal);
  }
  if (build !== undefined && present.trim() !== 'present') {
    for (let offset = 0, part = 0; offset < build.data.length; offset += WRITE_CHUNK, part += 1) {
      await client.writeFile(id, relative(`${ROOT}/apps/${build.sha}.parts/${String(part).padStart(6, '0')}`), build.data.subarray(offset, offset + WRITE_CHUNK), signal);
    }
  }
  await shell(client, id, SETUP, { ROOT, DIR: dir, PACKAGES: packages.join(' '), APP_SHA: build?.sha ?? '', SOCKET, NODE_LINK: NODE, AGENT, RELAY: `${dir}/relay${EXTENSION}` }, signal);
  return build === undefined ? undefined : `${ROOT}/apps/${build.sha}/${path.basename(build.bundle)}`;
}

const SETUP = `set -eu
mkdir -p "$ROOT/project" "$ROOT/artifacts" /Users/computer/Library/LaunchAgents
NODE=$(readlink -f "$(command -v node)")
ln -sfn "$NODE" "$NODE_LINK"
if [ ! -f "$DIR/installed" ]; then
  cd "$DIR"
  printf '{"private":true,"type":"module"}' > package.json
  npm install --no-audit --no-fund --loglevel=error \${=PACKAGES} >&2
  touch installed
fi
if [ -n "$APP_SHA" ] && [ ! -d "$ROOT/apps/$APP_SHA" ]; then
  rm -rf "$ROOT/apps/$APP_SHA.tmp" && mkdir -p "$ROOT/apps/$APP_SHA.tmp"
  cat "$ROOT/apps/$APP_SHA.parts"/* | gunzip | tar -xf - -C "$ROOT/apps/$APP_SHA.tmp"
  rm -rf "$ROOT/apps/$APP_SHA.parts" && mv "$ROOT/apps/$APP_SHA.tmp" "$ROOT/apps/$APP_SHA"
fi
if ! sudo -n true 2>/dev/null; then
  echo "granting node Accessibility and Screen Recording needs passwordless sudo, which this computer's image does not allow" >&2
  exit 1
fi
for service in kTCCServiceAccessibility kTCCServiceScreenCapture; do
  sudo -n sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "insert or replace into access (service, client, client_type, auth_value, auth_reason, auth_version, flags) values ('$service', '$NODE', 1, 2, 4, 1, 0)"
done
PLIST="/Users/computer/Library/LaunchAgents/$AGENT.plist"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$AGENT</string>
<key>ProgramArguments</key><array><string>$NODE_LINK</string><string>$RELAY</string><string>serve</string><string>$SOCKET</string></array>
<key>WorkingDirectory</key><string>$DIR</string>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>$ROOT/relay.log</string>
<key>StandardErrorPath</key><string>$ROOT/relay.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
rm -f "$SOCKET"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  sleep 0.5
done
for attempt in $(seq 1 50); do
  [ -S "$SOCKET" ] && exit 0
  sleep 0.2
done
echo "the relay on the Mac did not start:" >&2
tail -n 20 "$ROOT/relay.log" >&2 || true
exit 1
`;

/** Runs a shell line on the computer with `env`, and resolves to its stdout; a line that fails rejects with the end of its stderr. */
async function shell(client: RevylComputerClient, id: string, line: string, env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string> {
  const result = await client.exec(id, ['/bin/zsh', '-lc', line], { env, timeoutMs: SETUP_TIMEOUT_MS }, signal);
  if (result.exitCode !== 0) throw new Error(`setting up Revyl computer ${id} failed: ${result.stderr.toString('utf8').trim().split('\n').slice(-20).join('\n')}`);
  return result.stdout.toString('utf8');
}

/**
 * The app bundle as a gzipped tar, and the hash of the tar, which names it on
 * the Mac so a computer keeps one copy per build. The hash is of the tar
 * itself, since gzip stamps each archive with the time it was made.
 */
async function archive(bundle: string, signal: AbortSignal): Promise<Build> {
  const child = spawn('tar', ['-cf', '-', '-C', path.dirname(bundle), path.basename(bundle)], { signal, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new Error(`archiving ${bundle} for the Revyl computer failed: ${stderr.trim()}`);
  const tar = Buffer.concat(chunks);
  return { bundle, data: gzipSync(tar), sha: createHash('sha256').update(tar).digest('hex').slice(0, 32) };
}
