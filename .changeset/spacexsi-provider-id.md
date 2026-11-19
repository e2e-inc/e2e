---
'e2e': patch
---

The SuperGrok subscription provider is now `spacexsi`: `e2e login spacexsi`, `e2e logout spacexsi`, `e2e models spacexsi`, and its messages say SpaceXSI. `spacexai` and `grok` stay as aliases on all three commands. A login stored under `spacexai`, in the credentials file or in `E2E_OAUTH_CREDENTIALS`, is still read and stays under that key, so an older e2e on the same machine keeps finding it. `grok()` from `e2e/oauth/grok` and `e2e init --gateway grok` are unchanged. `e2e doctor --json` reports the login of a `grok()` model as `spacexsi`.
