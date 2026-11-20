---
"@e2e-dev/core": patch
---

The built-in agent's rules (`BASE_RULES`) now tell the model not to press a save or submit control again when the first press shows no change or is still in progress. The model must first check the screen for a confirmation, an error, a new location, or the changed record. It presses again only when that check shows the first press did not commit, and does not press again when it cannot tell. It also stays on the step's screen instead of navigating away to confirm a save.
