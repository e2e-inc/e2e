---
'@e2e-dev/core': patch
---

`resolveExpression`, the locator semantics the desktop engine and custom engines run over a semantic tree, no longer resolves `filter({ has })`, `filter({ hasText })`, scoped queries, and `getByText` in time quadratic in the number of candidates: a `filter({ has })` over 1,000 list rows (8,000 nodes) drops from about 350 ms to under 1 ms. A positioned `tap({ position })` no longer sleeps past its timeout while it waits for the node's box.
