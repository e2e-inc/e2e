---
"e2e": minor
---

**Breaking:** `e2e mcp` no longer serves the `run_tests` tool. Run tests with `npx e2e run`, which takes the same files and flags. The server keeps `open_session`, `tools`, `call`, and `close_session`, and `open_session {test}` still runs one test in a session.
