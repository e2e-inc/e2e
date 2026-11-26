/**
 * The sessions of an attempt beside the test's own, as the attempt keeps
 * them: the hosts and sessions the test opened with `launch()` from
 * `@e2e-dev/core`, and the actors the attempt opened for it (`actors.ts`).
 * Their steps are in its record, each under the session's name, the videos
 * they recorded among its artifacts, and their end is the attempt's. What
 * the test opened and left open is closed with it; a session opened outside
 * every test only has its steps recorded.
 */

import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { markAbandonedRejection } from '@e2e-dev/core/lib/internal/abandoned';
import { classifyError, InfrastructureError, TestError, withHint, type E2EError } from '@e2e-dev/core/lib/internal/errors';
import { keeps, type Keep } from '@e2e-dev/core/lib/internal/recording-modes';
import { withTimeout } from '@e2e-dev/core/lib/internal/time';
import type { ArtifactSink } from '@e2e-dev/core/lib/run/fixtures';
import { mirrorGuestSteps, type AttemptGuests, type GuestHost, type GuestMirror, type GuestSeat, type GuestSession, type GuestSteps } from '@e2e-dev/core/lib/run/guest-steps';
import type { AttemptRecord, SessionVideo } from '@e2e-dev/core/lib/run/records';
import type { StepRecorder } from '@e2e-dev/core/lib/run/steps';

/** Where an attempt's videos go, beside its own `video.webm`; a report path, so POSIX. */
const VIDEO_DIR = 'video';

/** A video a session handed over: the attempt's own copy of a file, or a hosted link. */
type HeldVideo = { readonly actor: string } & (
  | { readonly file: string; readonly startedAt: string | undefined }
  | { readonly url: string; readonly mediaType: string; readonly startedAt: string }
);

export interface AttemptGuestOptions {
  /** The attempt's own video rule, undefined when it records none: a session's video is kept, or dropped, by the same rule. */
  readonly keep: Keep | undefined;
  /** Goes before a video's file name. A serial group's members share one artifact directory and name their sessions alike, so each passes its own. */
  readonly videoPrefix: string;
  /** How long closing one host or session may take, every phase of its own cleanup included. */
  readonly cleanupTimeout: number;
}

/** A session the attempt closes: one the test opened, or an actor the attempt opened for it. */
interface KeptSession {
  readonly session: GuestSession;
  /** What an error calls it: `actor "reviewer"`, or the `launch()` session it is. */
  readonly called: string;
  /** Stops what the body left running on it. */
  stop(): Promise<void>;
}

const LAUNCHED_SESSION = 'a session the test opened with launch()';

/** How an actor the attempt opens itself joins it; see `AttemptGuestSessions.actor`. */
export interface ActorSeat {
  readonly steps: GuestMirror;
  /** Takes a video the actor recorded under the attempt's own directory, where it stays. */
  video(recording: SessionVideo): Promise<void>;
  /**
   * Hands over the open actor. `stop` ends what the body left running on
   * it without closing it: teardown may still drive an actor, as it may the
   * test's own session.
   */
  open(session: GuestSession, stop: () => Promise<void>): void;
}

export class AttemptGuestSessions {
  /** The sessions the test opened and the actors opened for it, which the attempt closes. */
  private readonly sessions: KeptSession[] = [];
  /** The hosts the test launched, which the attempt closes. */
  private readonly hosts: GuestHost[] = [];
  private readonly mirrors: GuestMirror[] = [];
  /** The openings in flight: seats reserved and not taken yet, by what cancels each, with the call it is. */
  private readonly opening = new Map<AbortController, string>();
  /** Each close this attempt asked for, by what it closes: asked again, it is the same wait, not a second budget. */
  private readonly closing = new Map<object, Promise<void>>();
  private readonly videos: HeldVideo[] = [];
  /** Copies still being written; `settle` waits for them, so none outlives it unregistered. */
  private readonly copying = new Set<Promise<void>>();
  private readonly failures: E2EError[] = [];
  /** Sessions named so far: `launch-1`, `launch-2`, in the order they joined. */
  private named = 0;
  /** Whether the attempt still takes hosts and sessions; false from the start of `settle`. */
  private taking = true;
  /** Whether a session may still hand over a video: until the ones `settle` closes have. */
  private holding = true;

  /** What the attempt publishes for `launch()` to find. */
  readonly offer: AttemptGuests;

  constructor(private readonly steps: StepRecorder, private readonly artifacts: ArtifactSink, private readonly options: AttemptGuestOptions) {
    this.offer = {
      video: options.keep !== undefined,
      host: () => this.seat('launch()', (host: GuestHost) => {
        this.hosts.push(host);
        return true as const;
      }),
      session: () => {
        const actor = this.name();
        return this.seat('host.newSession()', (session: GuestSession) => {
          this.sessions.push({ session, called: LAUNCHED_SESSION, stop: () => this.close(session, LAUNCHED_SESSION) });
          return this.mirror(actor, session.root);
        });
      },
      visit: (session) => this.mirror(this.name(), session.root),
      gaveUp: markAbandonedRejection,
    };
  }

  /**
   * The place of an actor the attempt opens itself (`run/actors.ts`): its
   * steps are told under `name`, its fixture's, from the project at `root`.
   */
  actor(name: string, root: string): ActorSeat {
    const steps = mirrorGuestSteps(this.steps, name, root);
    this.mirrors.push(steps);
    return {
      steps,
      video: (recording) => this.hold(name, recording, 'in place'),
      open: (session, stop) => {
        this.sessions.push({ session, called: `actor "${name}"`, stop });
      },
    };
  }

  /**
   * Fails the steps the body left running on these sessions and stops them
   * (`quiesce`): teardown starts with none of them running, as it does for
   * the test's own. Returns the errors naming them.
   */
  async abandonRunning(): Promise<E2EError[]> {
    const errors: E2EError[] = this.sessions.flatMap(({ session }) => {
      const error = session.abandonRunning();
      return error === undefined ? [] : [classifyError(error)];
    });
    // An opening still in flight was not awaited either; `quiesce` cancels it, and its rejection is expected.
    for (const call of this.opening.values()) {
      errors.push(new TestError('STEP_NOT_AWAITED', withHint(`the test body returned before ${call} finished`, 'put `await` in front of it')));
    }
    await this.quiesce();
    return errors;
  }

  /**
   * Stops what the body left in flight once it is over, however it ended:
   * an opening still under way is cancelled, and a session with a step
   * still running is stopped. One the test opened is closed, which cuts the
   * step; an actor's step is cut and the actor stays open (`ActorSeat.open`).
   * A timeout or an interrupt cuts the test's own steps at once, and a
   * session's must not go on driving the app through teardown.
   */
  async quiesce(): Promise<void> {
    this.cancelOpenings();
    await Promise.all(this.sessions.filter(({ session }) => session.busy()).map((kept) => kept.stop()));
  }

  /**
   * Ends the attempt's part in what the test opened: closes its sessions and
   * hosts, then keeps or drops the videos they handed over by how the
   * attempt ended. Returns what closing found. Call it once the status is
   * set and before the artifacts settle.
   */
  async settle(status: AttemptRecord['status']): Promise<readonly E2EError[]> {
    this.taking = false;
    this.cancelOpenings();
    await Promise.all(this.sessions.map(({ session, called }) => this.close(session, called)));
    // A host closes its open session first, so that session's video is handed over before the copies are waited for.
    await Promise.all(this.hosts.map((host) => this.close(host, 'a host the test opened with launch()')));
    this.holding = false;
    await Promise.all(this.copying);
    for (const mirror of this.mirrors) mirror.cut();
    const kept = this.options.keep !== undefined && keeps(this.options.keep, status);
    for (const video of this.videos.splice(0)) {
      if ('url' in video) {
        if (kept) this.artifacts.link(video.url, { mediaType: video.mediaType, startedAt: video.startedAt, actor: video.actor });
      } else if (kept) {
        this.artifacts.register('video', video.file, { actor: video.actor, ...(video.startedAt === undefined ? {} : { startedAt: video.startedAt }) });
      } else {
        await rm(path.join(this.artifacts.dir, video.file), { force: true });
      }
    }
    return this.failures;
  }

  /**
   * Stops sharing the secrets of the hosts the test launched. Call it last,
   * once the artifacts have settled: a download still being rewritten is
   * redacted with them.
   */
  release(): void {
    for (const host of this.hosts) host.release();
  }

  private cancelOpenings(): void {
    for (const opening of this.opening.keys()) opening.abort();
  }

  private name(): string {
    this.named += 1;
    return `launch-${this.named}`;
  }

  /** A seat whose opening is cancelled when the body ends or the attempt settles before it is taken. */
  private seat<Opened, Taken>(call: string, take: (opened: Opened) => Taken): GuestSeat<Opened, Taken> {
    const opening = new AbortController();
    if (this.taking) this.opening.set(opening, call);
    else opening.abort();
    return {
      signal: opening.signal,
      take: (opened) => {
        this.opening.delete(opening);
        return this.taking && !opening.signal.aborted ? take(opened) : undefined;
      },
      release: () => {
        this.opening.delete(opening);
      },
    };
  }

  private mirror(actor: string, root: string): GuestSteps {
    const mirror = mirrorGuestSteps(this.steps, actor, root);
    this.mirrors.push(mirror);
    return { progress: mirror.progress, video: (recording) => this.hold(actor, recording, 'copied') };
  }

  /** Closes a host or session within the cleanup budget, once; a failure is the attempt's cleanup failure, not a throw. `called` names it in the timeout's error. */
  private close(what: GuestHost | GuestSession, called: string): Promise<void> {
    let closing = this.closing.get(what);
    if (closing === undefined) {
      closing = withTimeout(what.close(), this.options.cleanupTimeout, () => new InfrastructureError('CLEANUP_TIMEOUT', `${called} did not close`)).catch(
        (cause: unknown) => {
          // A close that found several failures throws them together: each is the attempt's, as the failure it is.
          for (const each of cause instanceof AggregateError ? cause.errors : [cause]) this.failures.push(classifyError(each));
        },
      );
      this.closing.set(what, closing);
    }
    return closing;
  }

  /**
   * Takes a video a session recorded. A file of a session the test opened
   * is `copied` under the attempt's artifacts first: its host deletes the
   * original when it closes. An actor's is already there, and stays `in place`.
   */
  private hold(actor: string, recording: SessionVideo, kept: 'copied' | 'in place'): Promise<void> {
    if (!this.holding || this.options.keep === undefined) return Promise.resolve();
    if ('url' in recording) {
      this.videos.push({ actor, ...recording });
      return Promise.resolve();
    }
    if (kept === 'in place') {
      this.videos.push({ actor, file: path.relative(this.artifacts.dir, recording.path).split(path.sep).join('/'), startedAt: recording.startedAt });
      return Promise.resolve();
    }
    const earlier = this.videos.filter((video) => video.actor === actor && 'file' in video).length;
    const name = `${this.options.videoPrefix}${actor}${earlier === 0 ? '' : `-part${earlier + 1}`}${path.extname(recording.path)}`;
    const file = path.posix.join(VIDEO_DIR, name);
    // Counted before the copy starts, so a second part of the same session takes the next name.
    this.videos.push({ actor, file, startedAt: recording.startedAt });
    const copying = (async () => {
      await mkdir(path.join(this.artifacts.dir, VIDEO_DIR), { recursive: true });
      await copyFile(recording.path, path.join(this.artifacts.dir, VIDEO_DIR, name));
    })().catch((cause: unknown) => {
      this.failures.push(classifyError(cause));
      const failed = this.videos.findIndex((video) => 'file' in video && video.file === file);
      if (failed !== -1) this.videos.splice(failed, 1);
    });
    this.copying.add(copying);
    return copying;
  }
}
