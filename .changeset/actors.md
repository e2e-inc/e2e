---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

A test can drive more than one session with actors. `actor()` from `@e2e-dev/web` or `@e2e-dev/mobile` is a fixture for `test.extend()`: `reviewer: actor({ session: 'reviewer' })` gives a test that names `reviewer` a second signed-in user, with its own `app`, `screen`, `agent`, and `browser`. On a web target an actor is a browser context of its own in the test's browser. `actor({ target: 'ios' })` runs it on another target of the config, so a browser test can drive a phone, and a phone test a browser. The runner runs the setup test an actor's `session` needs, reports each actor's steps and video under the fixture's name, keeps its agent recordings apart from the test's, and closes it with the test.

For engine authors: `actors: true` declares that an engine can run a second attempt while one is open. `EngineCleanupContext` and `EngineFixtureContext` carry `attemptId`, and `defineActor` from `e2e/engine` builds the `actor()` an engine package exports.
