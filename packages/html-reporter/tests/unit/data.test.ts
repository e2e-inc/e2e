import type { Report } from 'e2e';
import { describe, expect, it } from 'vitest';
import { buildModel, failuresByUser, timedVideos, videoPosition, videoUsers, type Artifact, type Step } from '../../app/data.ts';
import { failurePrompt } from '../../app/prompt.ts';
import fixture from '../../../e2e/schema/fixtures/report-v1.valid.json' with { type: 'json' };

// The page's own tsconfig checks this file: the model it tests reads the DOM.
const REPORT = fixture as unknown as Report;

describe('videos of more than one user', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const video = (id: string, startedAt: string, user?: string): Artifact => ({
    id,
    kind: 'video',
    mediaType: 'video/webm',
    path: `t/${user === undefined ? '' : `peers/${user}/`}${id}.webm`,
    redaction: 'incomplete',
    startedAt,
    producer: { kind: 'attempt' },
    ...(user === undefined ? {} : { user }),
  });
  const media = { mode: 'link', base: 'results' } as const;
  const artifacts = [video('mine', at(0)), video('hers', at(3), 'ava'), video('mine-2', at(6))];

  it("keeps each user's videos on a timeline of its own, so a peer's never cuts the test's own short", () => {
    expect(videoUsers(artifacts, media)).toEqual([undefined, 'ava']);
    expect(videoUsers([video('hers', at(3), 'ava'), video('mine', at(5))], media)).toEqual([undefined, 'ava']);
    const mine = timedVideos(artifacts, media);
    expect(mine.map((each) => [each.artifact.id, each.endsAt])).toEqual([
      ['mine', Date.parse(at(6))],
      ['mine-2', Infinity],
    ]);
    const hers = timedVideos(artifacts, media, 'ava');
    expect(hers.map((each) => [each.artifact.id, each.endsAt])).toEqual([['hers', Infinity]]);
    const step = (startedAt: string) => ({ startedAt }) as Step;
    expect(videoPosition(step(at(4)), mine)).toEqual({ video: 0, seconds: 4 });
    expect(videoPosition(step(at(4)), hers)).toEqual({ video: 0, seconds: 1 });
  });

  it('lists no user whose videos the page cannot show', () => {
    expect(videoUsers(artifacts, { mode: 'none' })).toEqual([]);
  });
});

describe('each user at the failure', () => {
  it("lists the test's own screen first, then each peer's under its name, and leaves out a user with none", () => {
    const model = buildModel({ report: REPORT, media: { mode: 'none' }, resultsDir: '.e2e/results', traces: {}, sources: {} });
    const attempt = model.attempts(model.results[0]!)[0]!;
    expect(failuresByUser(attempt).map(({ user, failure }) => [user, failure.url])).toEqual([
      [undefined, 'http://127.0.0.1:3000/todos'],
      ['guest', 'http://127.0.0.1:3000/invites'],
    ]);
    expect(failuresByUser({ ...attempt, failure: undefined, peers: { ...attempt.peers, bob: { target: 'web' } } }).map(({ user }) => user)).toEqual(['guest']);
  });
});

describe('the copied prompt', () => {
  it("names the peer of a step, the peer's screen at the failure, and the peer's files", () => {
    const model = buildModel({ report: REPORT, media: { mode: 'none' }, resultsDir: '.e2e/results', traces: {}, sources: {} });
    const result = model.results[0]!;
    const attempt = model.attempts(result)[0]!;
    const prompt = failurePrompt(model, result, attempt, { number: 1, count: 1 });
    expect(prompt).toContain(`3. passed guest · locator.click: getByRole('button', { name: 'Accept' }) (300ms)`);
    expect(prompt).toContain('- Screen: http://127.0.0.1:3000/todos\n- Closest on screen:');
    expect(prompt).toContain('- Screen of guest: http://127.0.0.1:3000/invites');
    expect(prompt).toContain('- .e2e/results/web/tests_example.e2e.ts__opens_app/attempt-0/peers/guest/video/video.webm: the screen tree at the failure, of guest');
    expect(prompt).toContain('- .e2e/results/web/tests_example.e2e.ts__opens_app/attempt-0/video/video.webm: the screen tree at the failure\n');
  });
});

describe('serial members', () => {
  it('show their own error, never the group\'s once they passed, and the group\'s when they have none', () => {
    const [group] = REPORT.run.serialGroups;
    const [attempt] = group!.attempts;
    const [member] = attempt!.members;
    const result = REPORT.run.results.find((candidate) => candidate.serialGroupId === group!.id);
    const failure = REPORT.run.results.flatMap((each) => each.attempts).find((each) => each.error !== undefined)!.error!;
    const members = [
      { ...member!, testId: 'failed', status: 'failed', error: failure },
      { ...member!, testId: 'passed', status: 'passed' },
      { ...member!, testId: 'skipped', status: 'skipped' },
      { ...member!, testId: 'failed in afterAll', status: 'failed' },
    ] as const;
    const model = buildModel({
      report: {
        ...REPORT,
        run: {
          ...REPORT.run,
          results: members.map(({ testId }) => ({ ...result!, testId, selected: true })),
          serialGroups: [{ ...group!, attempts: [{ ...attempt!, error: failure, members }] }],
        },
      },
      media: { mode: 'none' },
      resultsDir: '.e2e/results',
      traces: {},
      sources: {},
    });
    expect(model.results.map((each) => [each.testId, model.attempts(each)[0]?.error?.message])).toEqual([
      ['failed', failure.message],
      ['passed', undefined],
      ['skipped', failure.message],
      ['failed in afterAll', failure.message],
    ]);
  });
});
