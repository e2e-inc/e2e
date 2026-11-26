---
'@e2e-dev/mobile': patch
---

On iOS, elements of a page inside a WebView no longer all read as focused while no field on the page has the focus, so `toBeFocused` and the model's view of the screen are right there.
