---
"@e2e-dev/mobile": patch
---

`getAttribute()` and `toHaveAttribute()` read `label`, `resource-id`, `class`, and, on Android, `content-desc` on a device node, the attributes an Appium suite asks for. Before, a device node carried only `placeholder`.
