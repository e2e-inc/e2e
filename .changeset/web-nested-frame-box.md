---
'@e2e-dev/web': patch
---

A located node in a nested frame reports the part of its box every frame around it shows, as the screen's tree already did, and a frame under a CSS transform scales the box as it draws it. Before, the box was cut only to the innermost frame, so `boundingBox()` and `locator.screenshot()` could reach past an outer frame.
