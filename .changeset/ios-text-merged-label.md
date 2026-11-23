---
'@e2e-dev/mobile': patch
---

On iOS, `getByText` matches a control by one part of its merged label. iOS joins the texts inside a control into one label (`Trail Mix, 250 g`) and doesn't list them, so `getByText('Trail Mix')` now finds the control, as it finds the text inside it on Android and the web. `exact` applies to each part. Before, only the whole label matched. A text that was unique on iOS can now fail with `LOCATOR_AMBIGUOUS` when a control's label has it as a part. Android already works this way.
