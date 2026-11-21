---
"@e2e-dev/web": patch
---

Read ARIA roles and the checked, expanded, pressed, and disabled states without letter-case sensitivity, as Chrome's accessibility tree does, so `aria-checked="True"` reads as checked and `role="Button"` as a button.
