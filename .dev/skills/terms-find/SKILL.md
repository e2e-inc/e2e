---
name: terms-find
description: Find how Microsoft translates a technical term into a language, to settle a Terms.md row. Looks the term up in Microsoft's own Terminology Search (a public Power BI report) in the browser, and falls back to a script that aligns Microsoft Learn and MDN pages. Use for /terms-find, when asked what a word is called in Spanish (or another locale) at Microsoft, or before adding a row with terms-add.
metadata:
  internal: true
---

# Find a term

Microsoft publishes its official translated glossary, nearly 100 languages,
with part of speech, gender, and number. This skill reads it, then reports
what Microsoft calls the term so the user can decide the `Terms.md` row.

## Steps

1. Take the English term and the locale (`es`, `ja`, `zh`, `fr`, `pt-BR`, ...).
   If either is missing, ask once.
2. **Look it up in the browser** (the Chrome tools; load them with ToolSearch
   if deferred; see `claude-in-chrome`). Go straight to the report, no sign-in:

   ```
   https://msit.powerbi.com/view?r=eyJrIjoiODJmYjU4Y2YtM2M0ZC00YzYxLWE1YTktNzFjYmYxNTAxNjQ0IiwidCI6IjcyZjk4OGJmLTg2ZjEtNDFhZi05MWFiLTJkN2NkMDExZGI0NyIsImMiOjV9
   ```

   (It is the "Microsoft Terminology Search" linked from
   `learn.microsoft.com/en-us/globalization/reference/microsoft-terminology`.)
   - Open a new tab, navigate, wait a few seconds for the report to render.
   - **Language:** click the "Select language(s)" dropdown, type the language
     name in its search box, press Enter, tick the box, press Escape. The
     second table then shows only that language. Do this once per tab.
   - **Term:** click "Search source term", select its text, type the term,
     press Enter, wait 2 seconds.
   - **Read it** with `get_page_text` (long), or paste `scripts/ms-terminology.js`
     once into the page (`javascript_tool`). After each search, `await msFind('<term>')`
     scrolls to the entry that is exactly the term, selects it, and returns its
     concept and translations: a few lines per term. Many terms fit in one
     `browser_batch` (triple-click the box, type, Return, wait 2s, `msFind`).
3. **Read the result as evidence.**
   - The search matches any source term that *contains* the text, and the
     tables load about 20 rows at a time; `msFind` handles that. `exact: false`
     means Microsoft has no entry for the bare term: say so, and read the
     compounds with `msTerms()` instead. `exactCase: false` means only a
     differently cased entry exists, and `settled: false` means the
     translation table did not visibly change after the click: do not report
     `translations` from a result that is not settled.
   - The two tables are sorted separately, so `msTerms()` lists do not pair
     row by row. `msFind` selects the entry, which filters the translations.
   - The first table's Concept column says which sense it is (Visual Studio,
     Azure, Excel...). Prefer the developer-tools sense for this project.
   - Several translations of one term (by region, product) are all
     Microsoft's: report the one for the locale's main region first.
4. **Fallback when the report has no entry:** the script, which aligns the
   same page on Microsoft Learn and MDN Web Docs in two languages and ranks
   the words that appear in the translation (Node 22+, network, no install):

   ```sh
   node .dev/skills/terms-find/scripts/find.mjs <locale> "<English term>"
   node .dev/skills/terms-find/scripts/find.mjs es "pipeline" --pages 12 --samples 6
   node .dev/skills/terms-find/scripts/find.mjs es "assertion" --source mdn --json
   ```

   It asks Learn first, then MDN (locales es, ja, zh, fr, ko, pt-BR, ru)
   when Learn has fewer than 8 blocks with the term; `--source learn|mdn`
   forces one. Read its candidates and samples as weak evidence. Never run it
   over many terms in a row: Learn answers HTTP 429 after a few hundred
   requests, and the script says so when it happens.
5. **Report to the user:** the English term, what Microsoft calls it in the
   locale (with gender and the other forms the docs would use), which source
   and product sense it came from, and how it compares with the row in
   `docs/<locale>/Terms.md` (`node .dev/skills/translation-review/scripts/terms.mjs list <locale>`;
   a locale with no `Terms.md` has no glossary yet, so say that instead).
6. Add or change the row only when the user says so, through `terms-add`.
   Microsoft is a reference: the project's glossary decides. A term the
   project keeps in English (`fixture`), or a loanword it prefers (`test` for
   Microsoft's `prueba`), stays as the user set it.

## Limits

- Microsoft's vocabulary is Windows, Office, Azure, and .NET: terms specific
  to e2e or to test frameworks may have no entry, or a different sense.
- It is Microsoft's house style, not the community's: it says `prueba` where
  this project's Spanish says `test`.
- The Power BI report is a visual: its layout and the dropdown can change.
  Screenshot before clicking, and do not trust fixed coordinates.
- The fallback script pairs page blocks by position, so a page whose two
  versions differ in block count is skipped, and a page with the same count can
  still pair unrelated blocks (a banner on one side): read the samples before
  trusting a candidate; MDN translations lag the
  English, so MDN pairs few pages.
