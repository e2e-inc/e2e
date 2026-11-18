---
name: translation-review
description: Check a docs translation (docs/<locale>/) for missing content and for terms that drifted from the locale's Terms.md - pages not translated, sections that lost a list item, table row, link, or component, prose left in English or cut short. Use after writing or editing a translation, when asked to review, proofread, or verify a locale, and before opening a docs(<locale>) PR.
metadata:
  internal: true
---

# Translation review

The docs checks (`pnpm docs:check`) warn when a translated page's outline,
code blocks, or labels drift from the English page, but only for the locales
`scripts/check-docs-translations.ts` and `scripts/check-docs-anchors.ts`
register. They cannot see a dropped list item, a paragraph skipped inside a
section, or a term translated three ways. This skill does, for any folder under
`docs/` with a `navigation.json` or a `Terms.md`.

## Run it

From the repo root (Node 22+, no install):

```sh
node .dev/skills/translation-review/scripts/review.ts <locale>            # every page
node .dev/skills/translation-review/scripts/review.ts <locale> --page ci.mdx
node .dev/skills/translation-review/scripts/review.ts <locale> --json     # for tooling
```

It pairs each English section with its translation by position and reports,
per page and section:

| Check | Severity |
| --- | --- |
| A page of the minimum set (issue #1890) is not translated | error |
| Section count differs from English | error |
| A link target (Markdown or a component's `href`), list item, table row, code block, or component is missing | error |
| Prose is under 70% of the English word count (content cut), in a section of 25 or more English words | error |
| Prose is mostly the English words (left untranslated), in a section of 25 or more English words; or English prose has no translation | error |
| An inline-code span of English is missing, or prose is over 190% (content added), in a section of 25 or more English words | warning |
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
itself. A form matches as the start of a word, ignoring case, and a space and
a hyphen stand for each other ("sign in" also finds "sign-in"). Give the
feminine and plural forms of an adjective too: `bloqueado` does not match
`bloqueada`. A locale without `Terms.md` is checked for content only; create
one with `node .dev/skills/translation-review/scripts/terms.ts init <locale>
"<Language>"`. Add or change rows through the `terms-add` skill.

`ja` and `zh` keep their glossary as a table in their README, which the DeepL
check (`scripts/deepl-review.ts`) reads. These skills read `Terms.md` only, so
term checks are off for those locales until their table moves to a `Terms.md`
and `parseGlossary` reads that; `init` refuses to start a second glossary
beside a README table.

## Limits

- For Chinese, Japanese, and Korean the length checks are skipped (a character is not a word, and the ratio to English is not calibrated); the other checks run.
- It compares counts and words, not meaning. A fluent translation that says
  something else passes; read the pages, or use `translation-viewer`'s model
  read, for that.
- Paragraph order inside a section is not checked, only what the section
  holds.
- Frontmatter other than `title`, `description`, and `sidebarTitle` is not
  read. The docs checks only require a translated page to have a `title`, so a
  wrong or missing key such as `og:image` is yours to check against the English
  page.
- Word counts treat each Japanese, Chinese, or Korean character as a word, so
  the 70% and 190% thresholds are rough for those languages; read a finding
  before trusting it.
- `--page` reviews only that page and skips the minimum-set check.
