---
"@e2e-dev/web": patch
---

`toHaveScreenshot` and the pixels a model reads stop CSS animations, transitions, and `element.animate()` inside closed shadow roots too. As before, one that ends runs to its end, where it stays and fires its end events, and one that loops forever is shown as if it had not started. `app.screenshot()` and failure evidence pause each animation where it is and resume it, so they leave the page as it was. An animation that is paused, has a zero playback rate, or follows a scroll position is left as the page set it.
