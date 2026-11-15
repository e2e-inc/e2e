---
"@e2e-dev/decision": patch
---

`decisionFilter()` counts a test as touched, and scores it so, when a setup file that saves one of its peers' sessions changed, as it does for the test's own session; a judged test's score is the highest of its own and its setups'.
