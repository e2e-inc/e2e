---
'@e2e-dev/web': patch
---

A located node in a nested frame reports the part of its box every frame around it shows, as the screen's tree already did. Before, the box was cut only to the innermost frame, so `boundingBox()`, `locator.screenshot()`, and a percentage `position` could reach past an outer frame.
