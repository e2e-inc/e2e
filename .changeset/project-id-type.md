---
'@e2e-dev/core': patch
---

`projectId` must be a string: a number, boolean, `null`, object or array is `INVALID_CONFIG` when the config loads, as every other wrong-typed option is. Before, `projectId: 12345` in a JavaScript config crashed the worker of every test (`WORKER_CRASH`, exit code 3) with an error that never named `projectId`, and wrote a `report.json` whose `project.id` was a number against the report-1 schema; `null` failed with a bare `TypeError`.
