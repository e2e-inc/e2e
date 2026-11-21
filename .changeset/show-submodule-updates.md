---
'@e2e-dev/decision': patch
'e2e': patch
---

Include changed submodules in `--changed-since`, even when Git is configured to ignore them. The decision filter and exploration brief show committed submodule pointers without expanding the dependency diff.
