---
'@e2e-dev/mobile': patch
---

On iOS, a `getByText` query that matches no node is tried against each part of a control's merged label, so `getByText('Trail Mix')` finds a card labelled `Trail Mix, 250 g`.
