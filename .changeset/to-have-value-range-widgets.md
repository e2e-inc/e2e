---
"@e2e-dev/web": patch
---

`expect(locator).toHaveValue` reads a `slider`, `spinbutton`, `progressbar`, `meter`, or `scrollbar` that is not a native form control or an editor: its `aria-valuetext`, else its `aria-valuenow`, else a `<progress>` or `<meter>`'s clamped value or its `value` attribute. `locator.inputValue()` reads the same value. Form controls read as before.
