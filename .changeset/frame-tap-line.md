---
'e2e': patch
'@e2e-dev/web': patch
---

Record MCP node actions inside observed web frames with frame-scoped locators. The web engine still observes nodes inside shadow-scoped iframes but no longer reports a frame path for them.
