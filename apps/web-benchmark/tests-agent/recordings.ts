/**
 * The reason a scenario added without a keyed record run stays skipped. CI
 * replays committed recordings read-only and calls the model for a step with
 * none, so an unrecorded hard scenario would call the model live on every pull
 * request, and fail the gate whenever the pinned model fails it. The test is
 * declared and skipped instead, and turns on in the pull request that commits
 * its recording.
 */
export const UNRECORDED =
  'no committed recording yet: record it with a keyed test:agent run and commit the entries to enable it';
