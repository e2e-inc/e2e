---
'e2e': patch
'@e2e-dev/core': patch
---

Tests of one file can run at the same time on separate workers. `describe(title, { parallel: true }, fn)` does it for a group, `describe.configure({ parallel: true })` at the top of a file for the file, and `fullyParallel: true` in the config, on a target, or `--fully-parallel` for every file. A serial group still runs as one unit, and `{ parallel: false }` keeps a group or a file in order. Tests that run apart import the file again and share no state in it; a module the file imports stays one instance for the worker, unless it declares tests or hooks itself. Tests with `beforeAll` or `afterAll` hooks around them run in at most one batch per worker, and each batch runs the hooks one time. With one worker, the default in CI, they still run one at a time. Without any of these, a file's tests run in order on one worker, as before.
