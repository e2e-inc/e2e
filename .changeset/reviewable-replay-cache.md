---
'e2e': minor
'@e2e-dev/core': minor
---

**Breaking:** the file store keeps each test's replay recordings in one reviewable YAML file, `.e2e/cache/<test>.yml`, beside a generated `<test>.lock.json`. The YAML lists each step under its instruction and params, then per target what a replay does (`do`) and what it checks (`expect`); the lock holds the cache keys and provenance. Recordings in the old one-`<key>.json`-per-entry layout are no longer read: `e2e cache clear` removes the old files, then a `read-write` run records those steps again (clear before recording: it removes the new files too). `e2e cache ls` prints each recording's file, target, and instruction. `CacheStore.read` and `delete` take the step as an optional second argument, which a custom store may ignore.
