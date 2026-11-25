---
"@e2e-dev/core": patch
"e2e": patch
---

Fix an agent step on a dense page losing the rows cut off when its request grew too large for the model. After the history is shrunk, the next screen the model gets is listed whole, under the usual report of what changed, instead of "Screen unchanged". This covers the built-in agent and custom loops built with `createGrammarTools`.
