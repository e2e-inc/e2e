---
'@e2e-dev/core': patch
'e2e': patch
---

Refuse an engine server whose manifest carries a flag of the wrong type, such as `fileApps: "yes"` or `alwaysHeaded: null`, or an unknown `isolation`. The handshake read such a value as the flag left out and went on; it now fails the first connection with `ENGINE_FAILURE` naming the field.
