---
"e2e": patch
---

Add `peers`: more users in one test, each on an app of its own. `test('pays Ava', { peers: { ava: { session: 'ava' } } }, async ({ app, peers }) => ...)` opens Ava's app before `beforeEach`, restores her saved session, and closes it with the test. A peer can run on another target (`target`), as another agent (`agent`, `agentContext`), and on a phone, where it takes a device of its own. Every step, file, app log line, and replay recording of a peer carries its name in the report, the terminal, Markdown, the trace page, `--step`, and `--ai-trace`; its files go in `peers/<name>/`. `EnginePrepareInfo.peerSlots` tells an engine how many of its `slots` are for peers. A suite's own fixture named `peers` keeps working; only a test that declares peers through it, or on a target whose engine contributes one, is refused.
