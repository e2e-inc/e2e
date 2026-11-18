---
name: terms-add
description: Add or change a term in a docs locale's Terms.md, when the user says a word is translated a given way in a language, for example "agent is agente in Spanish". Keeps the table sorted, updates an existing row, and shows which pages now disagree. Use for /terms-add and any request to fix how a word is translated in docs/<locale>/.
metadata:
  internal: true
---

# Add a term

The user states a rule in plain words: `"fixture" stays "fixture" in
Spanish`, `"runner" is "ejecutor" in es`, `in French, "agent" is "agent"`.
Record it in `docs/<locale>/Terms.md` so every future translation, by any
engine or person, uses it.

## Steps

1. Read the rule as `<English term>` -> `<translation>` in `<language>`. If
   any of the three is missing or the language is ambiguous, ask once.
2. Find the locale code: the language's folder under `docs/` with a
   `navigation.json` or `Terms.md` (`es`, `ja`, `zh`, `pt-BR`, ...). A language with no
   folder yet has no `Terms.md`: tell the user, and offer to create one
   from `docs/es/Terms.md`'s header.
3. Run the edit script from the repo root; never hand-edit the table:

   ```sh
   node .dev/skills/translation-review/scripts/terms.mjs add <locale> "<English term>" "<translation>"
   ```

   - Several accepted forms go in one argument, ` / ` between them, the
     preferred one first: `"agente / agentes"`. Add the plural and verb
     forms the docs use: a form matches as the start of a word.
   - `--note "<why>"` records a reason, for a term that is not obvious.
   - The script inserts the row in alphabetical order, or replaces the
     translation of a row that exists and prints `updated "<term>": old ->
     new`. Report that line to the user: a changed term is a decision they
     should see.
4. See what the new rule touches:

   ```sh
   node .dev/skills/translation-review/scripts/review.mjs <locale>
   ```

   List the `term` warnings for this term (the pages that now disagree).
   Offer to fix them, one page at a time; do not rewrite pages unasked.
5. `node .dev/skills/translation-review/scripts/terms.mjs list <locale>`
   shows the whole table when the user asks what is recorded.

## Notes

- English is the key: one row per English term, case-insensitive. A
  second translation of the same term is an accepted form in that row, not
  a new row.
- MCP, CI, SDK, CLI, API, and UI are kept in English by each locale's
  README, not by a row.
- Only the translation column and notes are the user's to set. Do not
  reorder, rename, or delete other rows.
