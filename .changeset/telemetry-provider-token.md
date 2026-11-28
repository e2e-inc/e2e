---
'e2e': patch
---

Fold a run's `model_gateway` and `model_provider` into `other` when either is not a plain token, as an engine name, a platform, and a public model id already were. The two fields shipped a project-chosen string verbatim, and a provider name can be a URL or a path, which telemetry never sends.