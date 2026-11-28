---
'@e2e-dev/core': patch
---

The agent's `type` tool now says that a slider or a spin button (stepper) takes its new number through it, so a model types `18` into a slider instead of clicking and pressing keys on it and giving up. It steps the control with arrow keys only when the value it shows then is not that number.
