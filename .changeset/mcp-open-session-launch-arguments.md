---
'e2e': patch
---

`open_session`'s `app` now takes `launchArguments`, as a list or an object, so a session opened with `engine` and no config file can launch its app with arguments. They are checked the way a config target's `app.launchArguments` are.
