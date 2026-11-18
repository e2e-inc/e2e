---
name: translation-viewer
description: Open a docs translation (docs/<locale>/) in a browser viewer - a file tree on the left, the English page beside the translation, and an optional advisory read by Chrome's on-device model (Gemini Nano). Use to look at a locale side by side with English or to get a second model's opinion on its prose; for the completeness and terminology check, use translation-review.
metadata:
  internal: true
---

# Translation viewer

A second opinion on a translation from a model that did not write it, run on
the user's own machine. The docs checks (`pnpm docs:check`) cover the locales
they register, and `translation-review` compares what is inside each section;
this reviews the prose: meaning, glossary terms, register, grammar.

## Run it

1. Start the viewer from the repo root (any Node 22+; no install). Use a
   locale folder that has translated pages:

   ```sh
   node .dev/skills/translation-viewer/viewer/server.ts --locale <locale>
   ```

   It serves `http://127.0.0.1:4777/` and prints where findings are saved
   (`--out <dir>` changes it, `--port <n>` too). An unknown `--locale` falls
   back to the first locale found. Run it in the background.
2. Open `http://127.0.0.1:4777/` in **desktop Chrome 138 or newer**: with the
   Chrome tools if they are connected, else tell the user the URL. The Prompt
   API only exists in Chrome, in a secure context (`127.0.0.1` counts;
   `localhost` can resolve to IPv6, which the server does not bind, and the
   server refuses any other host name).
3. Tell the user to press **Enable Chrome AI** (the model download needs a
   click) and then **Review this file** or **Review all files**. Findings
   appear under each translated section and are saved as JSON.
4. Read `<out>/<locale>/<page>.json` (`{ path, findings: [{ section,
   severity, quote, problem, suggestion }] }`; a `/` in a nested page's path
   is written as `__` in the file name), judge each finding yourself, and
   fix the ones that are real in `docs/<locale>/`. Rerun the review skill and
   `pnpm docs:check` afterwards.

## The viewer

- A finding whose quote is not on the translated page is dropped: the model
  invents some.
- Each finding has a **Get prompt** button (and one for all findings of a
  section) that copies a ready prompt for the coding session: the page,
  section, finding, the glossary rows for the terms that occur in that
  section, the rules to follow, and the checks to rerun.
- Left: every translated page of the locale, as a tree. A badge shows `ok`,
  the number of findings, `stopped`, or `outline` once reviewed.
- Right: the English and translated source side by side, one row per
  heading section, paired by position. When the two outlines differ, the page
  shows a notice, the pairing may not match, and AI review skips that page:
  run `translation-review` and fix the outline first.
- The model sees, per section, the prose (code blocks become `[code block]`;
  imports and MDX tags are dropped, keeping title, subtitle, description,
  and label text; inline code and link text stay), the glossary rows of
  `docs/<locale>/Terms.md` (no terms when there is none) for the terms that
  occur, and a closed JSON schema for its answer. Long sections go in
  chunks of paired paragraphs; when a section's paragraph counts differ, both
  sides are cut at the same fractions, so all of it is read but the pairs are
  approximate.

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
  consistency is yours to check against the locale's `Terms.md`.
- Stop leaves the page unsaved: only a finished page writes its findings file.
