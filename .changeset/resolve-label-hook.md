---
"e2e": patch
"@e2e-dev/core": patch
---

`@e2e-dev/core/engine` exports `createResolver`, the locator rules of `resolveExpression` over any platform's nodes, so an engine whose platform reads more than the tree carries (a browser's text, hidden, and state rules, and its match order) decides queries, text filters, and the order of matches by its own rules. `createTextMatching` builds the text rules `matchesText` applies. Both close over nothing, so an engine that matches in a page sends their source there.
