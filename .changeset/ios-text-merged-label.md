---
'@e2e-dev/mobile': patch
---

On iOS, a control can now be found with `getByText` by one part of its merged label. The texts inside an iOS control are joined into one label (`Trail Mix, 250 g`) and aren't listed below it. So the control is now matched by `getByText('Trail Mix')`, the same way the text inside it is matched on Android and the web. Before, only the whole label was matched. `exact` is applied to each part.

A `getByText` query that matched one node on iOS can now fail with `LOCATOR_AMBIGUOUS` if a control's label also has the text as a part. On Android, the text is listed inside the control, so the query was already ambiguous there.
