---
'e2e': patch
'@e2e-dev/core': patch
---

Replay anchors now skip Chinese, Japanese and Korean dates and times (`2026年11月15日`, `2026년 11월 15일`, `12時30分`) and numeric dates with a four-digit year (`2026/11/15`, `15.11.2026`, `15-11-2026`, `11/15/2026`) as volatile text, so a recording that showed today's date no longer goes stale the next day. Entries already recorded with such a date as an anchor stay stale until they are re-recorded, which matters under `--strict-cache`.
