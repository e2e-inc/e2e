---
"@e2e-dev/core": patch
---

Stop printing the AI SDK's `toolChoice` warning for models that do not support forced tool calls, such as Claude Sonnet 5.5: e2e already switches those to `auto`. Every other AI SDK warning still prints.
