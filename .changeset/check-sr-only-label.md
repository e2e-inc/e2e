---
"@e2e-dev/web": patch
---

`check`, `uncheck`, and `tap` click a checkbox or radio that `sr-only` or `visually-hidden` clips, the usual toggle-switch markup, through its own label instead of failing with `intercepts pointer events`. A full-size one with `pointer-events: none` is clicked through its label the same way. `uncheck` still refuses a native radio without clicking it.
