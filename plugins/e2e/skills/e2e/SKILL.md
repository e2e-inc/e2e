---
name: e2e
description: Writes, runs, and debugs web, mobile, and desktop end-to-end tests with e2e (mixing agent.act goals with locator assertions), drives apps live over e2e mcp, and runs e2e explore bug bashes. Use when a project uses e2e or asks for end-to-end, browser, mobile, or agentic UI tests, live app checks, or QA bug bashes.
---

# e2e: agentic end-to-end tests

e2e runs UI and API tests that mix agent instructions (`agent.act`,
`agent.assert`, `agent.waitFor`, `agent.extract`) with exact actions and
checks (`screen`, `app`, `browser`, `device`, `request`, `expect`). Engines:
`@e2e-dev/web` (browsers), `@e2e-dev/mobile` (iOS/Android), and
`@e2e-dev/desktop` (macOS prototype).

## Start here: pick the reference for the job

Load only the one reference that matches the current task before acting. Each
stands on its own; inside a long reference, read its `## Contents` list and
jump to the sections you need instead of reading everything upfront.
`npx e2e guide <topic>` prints the installed package's copy; prefer it when
versions differ.

| When you are | Topic | Read |
| --- | --- | --- |
| Adding e2e, writing `e2e.config.ts`, starting the app, configuring models or mobile targets | `setup` | [references/setup.md](references/setup.md) |
| Driving the running app live, checking UI changes, taking screenshots or videos, trying locators, recording lines over `e2e mcp` | `mcp` | [references/mcp.md](references/mcp.md) |
| Writing or fixing a test (structure, fixtures, locators, matchers, sessions, `browser`, API tests) | `writing-tests` | [references/writing-tests.md](references/writing-tests.md) |
| Adding `agent.*` steps, picking models, tuning cost/budgets, replay cache | `agent` | [references/agent.md](references/agent.md) |
| Running tests, CLI flags, CI, reporters, `report.json`, exit codes | `running` | [references/running.md](references/running.md) |
| Fixing a failed run, error codes, rerunning fast, `--headed`, `--debug`, `--ai-trace`, reporting e2e bugs | `debugging` | [references/debugging.md](references/debugging.md) |
| Running goal-driven exploration without a test file (`e2e explore`) | `explore` | [references/explore.md](references/explore.md) |
| Running a bug bash or QA pass across an app or branch | `bug-bash` | [references/bug-bash.md](references/bug-bash.md) |

Full docs ship in `node_modules/e2e/docs/` (e.g. `/reference/cli` is
`docs/reference/cli.mdx`). Complete examples live at
https://github.com/e2e-inc/e2e/tree/main/examples.

## Workflow

1. Inspect `e2e.config.ts` (or `.mts`/`.js`/`.mjs`) and `package.json`. If e2e
   is not installed and the user asked for it, read `setup`.
2. Read the one matching reference (`writing-tests` for tests; `mcp` when
   driving live, writing steps as you walk and preferring `run_code` over many
   single actions; `agent` when adding `agent.*` steps).
3. Shape each file per `writing-tests` ("Structure"): one top-level `describe`
   per feature, one behavior and one goal per test, arrange -> act -> assert
   with every `expect` and `agent.assert` at the end. Use `.waitFor()` on a
   narrowed locator for mid-way states, name repeated locators/values, and
   create/delete server records in `test.extend` fixtures (`try`/`finally`).
4. **Check every test that removes, edits, or toggles one item of a list:**
   its arrange block adds two items, it acts on the second item shown (in a
   newest-first list, the item added first), never the first, and it checks
   that the first item is unchanged. An app that always changes the first row
   passes a test that acts on the first row.
5. Run only the test you edit:
   `npx e2e run tests/<feature>.e2e.ts:<line> --action-timeout 5000 --retries 0`,
   keeping the replay cache on until green. Once it passes, drop
   `--action-timeout` and verify once with `--no-cache` if it uses `agent.*`.
6. On failure, fix from the terminal failure block and
   `.e2e/results/<test>/trace.md` first (topic `debugging`); never re-walk
   from scratch over MCP just to inspect a screen.

## Rules

- **No unsolicited setup:** ask before adding e2e if not requested, naming any
  existing framework.
- **CLI and config:** run `npx e2e ...` (or `pnpm exec e2e ...`). Config and
  test files are ESM (`export default { ... } satisfies E2EConfig`); `targets`
  is required.
- **Imports:** import `test`, `describe`, hooks, `expect`, `credentials`, and
  `secrets` from `e2e`; import `test`, `describe`, and hooks from
  `@e2e-dev/web`, `@e2e-dev/mobile`, or `@e2e-dev/desktop` when using their
  engine fixture.
- **Secrets:** never put secrets in test code. Declare them under
  `credentials` or `secrets` and pass `credentials.user(name).password` or
  `secrets.get(name)` only to `fill()` or `agent.act` `params`.
- **Locators and waits:** locators resolve lazily; actions and `expect` wait;
  `count()` and `isVisible()` read immediately; two matches fail with
  `LOCATOR_AMBIGUOUS`. Never sleep; wait for state.
- **Test shape:** one behavior per test, arrange -> act -> assert with every
  check at the end. Mid-way states (e.g. `Saved` before reopening) use
  `.waitFor()`, not `expect`.
- **List mutations:** add two items, act on the second item shown (never the
  first), and check the first is unchanged (topic `writing-tests`, "Act on the
  second item shown").
- **Agent goals and replay:** give `agent.act` the steps toward one goal with
  values in `params`; split when a later step needs a known screen state,
  risks `maxSteps`/`maxModelCalls` budgets, or needs a middle step boundary.
  End with a verifying matcher or `agent.assert` so the replay cache keeps the
  recording (reads, `expect.poll`, and plain-value `expect` confirm nothing).
- **MCP sessions:** in a directory without a config, `open_session {engine:
  "@e2e-dev/web", app: {url: "http://localhost:3000"}}` still works (topic
  `mcp`).
- **Runner output:** `.e2e/` is generated output: read it, never edit it.
- **e2e bugs or gaps:** when e2e itself breaks or misleads you, read
  `debugging` ("Feedback") for `npx e2e feedback`.
