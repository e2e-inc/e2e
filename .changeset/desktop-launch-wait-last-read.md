---
'@e2e-dev/desktop': patch
---

`app.open()` reports an unreadable window the same way every time. The launch wait's last read now gets as long as the slowest finished read, within the operation's budget, so "a read ran out of time" only appears when a read was slow, not when the wait ended mid-read.
