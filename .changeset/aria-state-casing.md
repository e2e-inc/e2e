---
"@e2e-dev/web": patch
---

Read ARIA roles and the checked, expanded, pressed, and disabled states without letter-case sensitivity, as Chrome's accessibility tree does, so `aria-checked="True"` reads as checked and `role="Button"` as a button. `getByRole` now applies the matchers' `banner` and `contentinfo` scope and `disabled` state. A sectioning tag whose first role Chrome accepts is not a sectioning role, such as `<nav role="none">`, no longer keeps a header or footer from being `banner` or `contentinfo`.
