---
'e2e': patch
---

The `t` prompt of `e2e run --watch` reads a title pattern the way `--grep` does. `/refund/i` matches "Refund flow" instead of the literal text `/refund/i`, and the prompt refuses a pattern `--grep` refuses, such as `/api/users`, whose `users` reads as flags. The rerun banner and the next `t` prompt show the pattern with its flags.
