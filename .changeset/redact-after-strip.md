---
'@e2e-dev/core': patch
'e2e': patch
---

Redact an error's message, stack, and details after stripping terminal controls, not before. A value the app shows with an ANSI escape through its middle used to have the escape removed after redaction had already run, which joined the halves back into the whole value: it reached `report.json`, the markdown, JUnit, and the trace as text. The same ordering is fixed for a runtime skip reason and an expected-failure reason, which are written to the report the same way.