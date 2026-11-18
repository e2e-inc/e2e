---
name: translation-viewer
description: Open a docs translation (docs/<locale>/) in a browser viewer - a file tree on the left, the English page beside the translation, and an optional advisory read by Chrome's on-device model (Gemini Nano). Use to look at a locale side by side with English or to get a second model's opinion on its prose; for the completeness and terminology check, use translation-review.
metadata:
  internal: true
---

# Translation viewer

A second opinion on a translation from a model that did not write it, run on
the user's own machine. `pnpm docs:check` already proves the outline, code,
and links match; this reviews the prose: meaning, glossary terms, register,
grammar.

## Run it

1. Start the viewer from the repo root (any Node 22+; no install):

   ```sh
   node .dev/skills/translation-viewer/viewer/server.mjs --locale es
   ```

   It serves `http://127.0.0.1:4777/` and prints where findings are saved
   (`--out <dir>` changes it, `--port <n>` too). Run it in the background.
2. Open `http://127.0.0.1:4777/` in **desktop Chrome 138 or newer**: with the
   Chrome tools if they are connected, else tell the user the URL. The Prompt
   API only exists in Chrome, in a secure context (`127.0.0.1` counts; `localhost` can resolve to IPv6, which the server does not bind).
3. Tell the user to press **Enable Chrome AI** (the model download needs a
   click) and then **Review this file** or **Review all files**. Findings
   appear under each translated section and are saved as JSON.
4. Read `<out>/<locale>/<page>.json` (`{ path, findings: [{ section,
   severity, quote, problem, suggestion }] }`), judge each finding yourself,
   and fix the ones that are real in `docs/<locale>/`. Rerun
   `pnpm docs:check` afterwards.

## The viewer

- A finding whose quote is not on the translated page is dropped: the model invents some.
- Each finding has a **Get prompt** button (and one for all findings of a section) that copies a ready prompt for the coding session: the page, section, finding, the `Terms.md` rows for the terms that occur in that section, the rules to follow, and the checks to rerun.
- Left: every translated page of the locale, as a tree. A badge shows `ok` or
  the number of findings once reviewed.
- Right: the English and translated source side by side, one row per
  heading section. The sections pair up because the checker holds both
  outlines equal.
- The model sees, per section, the prose only (code blocks become `[code
  block]`), the glossary rows of `docs/<locale>/Terms.md` (the README when there is none) for the terms that occur, and a
  closed JSON schema for its answer. Long sections go in paired chunks.

## Chrome's model needs

Chrome 138+ on Windows 10/11, macOS 13+, or Linux; about 22 GB free disk, and
a GPU with over 4 GB VRAM or 16 GB RAM with 4 cores. If **Enable Chrome AI**
reports no `LanguageModel` or "unavailable", check `chrome://on-device-internals`
and the flags `chrome://flags/#prompt-api-for-gemini-nano` and
`chrome://flags/#optimization-guide-on-device-model`. Without them the viewer
still works as a side-by-side reader.

## Limits

- Gemini Nano is small. It misses things and invents some: treat every
  finding as a lead to verify, never as a verdict, and do not apply one
  blindly. A clean run is not a native speaker's review.
- Its documented languages are English, Spanish, and Japanese. The viewer
  declares English as the input and output language for every locale, so for
  another language the model reads the text but its judgment is weaker, and
  Chrome may refuse it. Only Spanish has been run; the side-by-side reader
  works for any locale.
- It reviews one page at a time and sees no other page, so cross-page term
  consistency is yours to check against the locale README.
