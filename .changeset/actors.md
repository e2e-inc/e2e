---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

A test can drive more than one session with actors. `actor()` from `@e2e-dev/web` or `@e2e-dev/mobile` is a fixture for `test.extend()`: `reviewer: actor({ session: 'reviewer' })` gives a test that names `reviewer` a second signed-in user, with its own `app`, `screen`, `agent`, and `browser`. On a web target an actor is a browser context of its own in the test's browser, and a test that names only actors, as `{ author, reviewer }`, opens no session of its own: two actors are two contexts. `actor({ target: 'ios' })` runs it on another target of the config, so a browser test can drive a phone, and a phone test a browser. The runner runs the setup test an actor's `session` needs, reports each actor's steps and video under the fixture's name, keeps its agent recordings apart from the test's, and closes it with the test.

For engine authors: `actors: true` declares that an engine can run more than one attempt at a time. Every call carries the id its attempt's `startAttempt` got: `EngineCleanupContext` and `EngineFixtureContext` carry `attemptId`, and a serial group's tests call under the group's id, where each used an id of its own. `defineActor` from `e2e/engine` builds the `actor()` an engine package exports. `@e2e-dev/web` and `@e2e-dev/mobile` now need `@e2e-dev/core` and `e2e` 0.25.1 or later, the first releases with it.

For custom executors: `ctx.attempt.attemptId` is that same id, so in a serial group every test gets the group's. `surfaceOf(engine, attemptId)` from `@e2e-dev/web` reads the page of that attempt. Without the id it reads the one open attempt, and throws while a test has several sessions open.
