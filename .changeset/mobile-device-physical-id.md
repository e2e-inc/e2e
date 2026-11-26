---
"@e2e-dev/mobile": patch
---

A configured `device` (or `e2e run --device`) can now name a connected phone by the id `agent-device devices` lists: an iPhone or iPad by its UDID, an Android phone by its adb serial. Two phones of the same model can now be told apart:

```ts
mobile({ platform: 'ios', device: '00008030-001A2B3C0E12802E' })
```
