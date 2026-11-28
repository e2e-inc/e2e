/**
 * The reason an agentic test added without a keyed run stays skipped. CI
 * replays committed recordings read-only and calls the model for a step with
 * none, so an unrecorded hard scenario would call the model live on every pull
 * request, and fail the gate whenever the pinned model fails it. To enable
 * one: remove its skip, run it with a keyed `test:agent` run until it passes,
 * and commit the recordings that run writes in the same pull request. A
 * judgment (`agent.assert`) is never recorded and calls the model on every
 * run, as the other bug-book tests' judgments do.
 */
export const UNRECORDED =
  'not run with a model yet: remove this skip, pass it in a keyed test:agent run, and commit the recordings it writes';
