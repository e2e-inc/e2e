---
'e2e': patch
---

`e2e init` detects a Vite app and writes a web target that starts its `dev` script on the `vite` command's `--port`, else 5173, so the first run of a new Vite project passes. When it cannot tell where the app answers, it keeps the placeholder target and says why.
