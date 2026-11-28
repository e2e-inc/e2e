---
'@e2e-dev/revyl': patch
---

`revylDesktop()` from the new `@e2e-dev/revyl/desktop` entry runs the desktop engine on a Revyl Mac computer, set up with the project's engine versions and its `appPath` build. Without `computer`, each run creates a Mac and stops it at the end, which deletes it. With the id of a persistent computer, a running one is used and left running, and a stopped one is started for the run and stopped again after it, keeping its disk. `e2e doctor` checks `REVYL_API_KEY` and the persistent computer's state without starting a computer.
