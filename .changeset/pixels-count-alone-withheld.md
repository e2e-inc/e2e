---
'@e2e-dev/core': patch
---

An engine that withholds a screenshot and sends only the regions it masked is read as unproven masking (`MASKING_UNPROVEN`) even when the tree it read shows no secure field, since a tree read only in part can leave one out. Before, the withholding was lost: `toHaveScreenshot` waited out its timeout, and an agent step stopped asking for pixels for the rest of the session.
