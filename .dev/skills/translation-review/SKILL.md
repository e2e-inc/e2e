---
name: translation-review
description: Check a docs translation (docs/<locale>/) for missing content and for terms that drifted from the locale's Terms.md - pages not translated, sections that lost a list item, table row, link, or component, prose left in English or cut short. Use after writing or editing a translation, when asked to review, proofread, or verify a locale, and before opening a docs(<locale>) PR.
metadata:
  internal: true
---

# Translation review

`pnpm docs:check` proves the outline, code blocks, and link anchors match the
English page. It cannot see a dropped list item, a paragraph skipped inside a
section, or a term translated three ways. This skill does.

## Run it

From the repo root (Node 22+, no install):

```sh
node .dev/skills/translation-review/scripts/review.mjs <locale>            # every page
node .dev/skills/translation-review/scripts/review.mjs <locale> --page ci.mdx
node .dev/skills/translation-review/scripts/review.mjs <locale> --json     # for tooling
```

It pairs each English section with its translation by position and reports,
per page and section:

| Check | Severity |
| --- | --- |
| A page of the minimum set (issue #1890) is not translated | error |
| Section count differs from English | error |
| A link target, list item, table row, code block, or component is missing | error |
| Prose is under 70% of the English word count (content cut) | error |
| Prose is mostly the English words (left untranslated), or English prose has no translation | error |
| An inline-code span of English is missing, or prose is over 190% (content added) | warning |
| A term from `Terms.md` is in the English section and none of its forms are in the translation | warning |

Errors mean content is missing: exit code 1. Warnings are leads.

## What to do with the output

1. Open each finding's section in `docs/<locale>/<page>` beside the English
   page (the `translation-viewer` skill shows them side by side).
2. Fix real omissions in the translation, never the English page. A warning
   that is a false positive (the English word is in a quote, a link text, or
   a name) is fine to leave; if it comes up a lot for one term, the term's
   forms in `Terms.md` are missing a plural or conjugation: add it with
   `terms-add`.
3. A term finding that shows the translation is right and `Terms.md` is
   wrong is a decision for the maintainer of that locale: ask before
   changing the table.
4. Rerun the review and `pnpm docs:check` until the errors are gone. Say in
   the PR's `## Verified` how many warnings remain and why.

## Terms.md

`docs/<locale>/Terms.md` fixes how a term is translated, whichever engine or
person translates. One row per term in the table `| English | <Language> |
Notes |`: the second column may list accepted forms separated by ` / ` (the
plural, verb forms; the first is preferred), and a term kept in English repeats
itself. A form matches as the start of a word, ignoring case. A locale
without `Terms.md` is checked for content only; create one by copying
`docs/es/Terms.md`'s header, with the new language's name as the second
column. Add or change rows through the `terms-add` skill.

## Limits

- It compares counts and words, not meaning. A fluent translation that says
  something else passes; read the pages, or use `translation-viewer`'s model
  read, for that.
- Paragraph order inside a section is not checked, only what the section
  holds.
- Frontmatter other than `title`, `description`, and `sidebarTitle` is not
  read; `pnpm docs:check` covers keys and code.
