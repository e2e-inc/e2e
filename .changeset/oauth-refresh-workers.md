---
'e2e': patch
---

Parallel workers refresh an expired subscription login once between them. Before, each worker sent the same refresh token, so ChatGPT, SuperGrok, and OpenCode Console rejected all but one, and those workers failed with `LOGIN_REQUIRED` when the first refresh took more than 2 seconds.
