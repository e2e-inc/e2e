---
'e2e': patch
'@e2e-dev/core': patch
---

Attach to a test held at `screen.pause()` or `e2e run --step` with
`open_session {attach: "k3f9"}` in `e2e mcp`. Use the four-character ID
from the pause header. Run test statements, fill configured secrets, or
save screenshots on the held app with the target's normal session tools.
Start the run with `--video` to record activity while attached.
`close_session` detaches and leaves the test held.
