---
'e2e': patch
'@e2e-dev/decision': patch
---

`e2e run --since-last-run` (`sinceLastRun` on `run()` and `list()`) runs only what a change since the last run can affect, with no git ref to name. The first run with the flag runs every test and records the working tree, uncommitted and untracked files included. After that, a run with nothing changed runs only the tests that have not passed yet, and a run with a change hands the configured test filters the tests that have passed since, with `changes.head` set to the tree it recorded; a test that failed or is new runs without asking. With no filters configured, any change runs every test. The decision filter reads uncommitted edits to tracked files for such a run: use `--since-last-run` with this release of `@e2e-dev/decision` or later, since an older one diffs to `HEAD`, and a filter of your own must diff `changes.base` to `changes.head`. The report's `run.changes` holds `since: 'last-run'` and `files` for such a run, and no `base`. The project must be in a git repository. [Run only what changed since the last run](https://e2e.com/docs/filters#run-only-what-changed-since-the-last-run)
