# Ukrainian docs

The Ukrainian translation of the e2e docs. The site serves each page here at
`/docs/uk/<path>`; a page without a translation shows the English page with a
notice. English stays the source of truth.

This translation is best effort. English changes don't wait for it, so a page
here can lag behind its English page until someone who reads Ukrainian updates
it. `pnpm docs:check` warns when a page's outline or code blocks differ from
the English page, or when `navigation.json` is missing a tab or group key or
carries one `docs/docs.json` no longer has. It does not catch changed English
prose or label text.

## Layout

- `docs/uk/<path>.mdx` translates `docs/<path>.mdx`: same path, same file name.
- `navigation.json` holds the Ukrainian labels for every tab and group in
  `docs/docs.json` (`tabs`, `groups`), keyed by the English label. The
  navigation order and pages come from `docs/docs.json`; there is no second
  navigation to keep in sync.
- Images, snippets, and `docs/examples/` are shared with the English pages.

## Updating a translation

1. Translate the text: prose, frontmatter `title`, `description`, and
   `sidebarTitle`, and the human-readable attributes of components (`title`
   on `<Card>`, `<Accordion>`, `<Tab>`, `<Step>`, and the text inside `<Note>`,
   `<Warning>`, `<Tip>`).
2. Keep the outline: the same headings (h1 to h4) at the same levels in the
   same order, the same `<Tab>` and `<Accordion>` elements in the same order,
   and every `id="..."`. The site gives a translated heading the English
   heading's id by position, so links and the language switcher land on the
   same section. `pnpm docs:check` (`scripts/check-docs-translations.ts`) warns
   when the outline drifts.
3. Leave code alone: fenced code blocks (including comments and fence titles),
   inline code, URLs, link targets, and `#anchors` stay exactly as on the
   English page. `pnpm docs:check` warns when a code block differs. Links stay
   docs-root relative (`/quickstart#install`); the site points them at the
   Ukrainian pages.
4. Keep snippet imports relative to the translated file by adding one `..`
   level for `docs/uk/`: `./snippets/x.jsx` becomes `../snippets/x.jsx` at the
   docs root, and `../snippets/x.jsx` becomes `../../snippets/x.jsx` under a
   nested folder such as `docs/uk/ci/`.

When you update a page, bring its outline, code, and labels in line with the
English page, including changes English made since. An English placeholder
heading is fine until someone translates it; deleting the translated page
falls back to English. When an English page moves or is deleted, its
translation moves or goes with it in the same change.

After applying a GitHub review suggestion on wrapped prose, reread the whole
paragraph against the English page. `pnpm docs:check` fails if a line repeats
the end of the line above it, but it cannot detect a silently dropped sentence.

## Style

- Plain, concise technical Ukrainian following the 2019 Ukrainian orthography
  (*проєкт*, *вебзастосунок*, *вебсторінка*, *тайм-аут*, single consonants in
  common loanwords such as *ранер*, *коміт*, *акаунт*).
- Address the reader with lowercase *ви* (*ви*, *вас*, *вам*, *ваш*) and
  second-person plural imperatives: «Встановіть пакет», «Запустіть тест», not
  informal *ти* and not bureaucratic passive phrasing («Слід встановити»).
- Keep sentences short, as in the English pages. Split a long English sentence
  into two rather than chaining «який…, що…, який…».
- Write the way Ukrainian developers read and work. Use natural Ukrainian
  words where they are standard (*застосунок*, *рушій*, *збірка*, *налагодження*,
  *браузер*, *пристрій*, *знімок екрана*, *налаштування*, *плагін*,
  *провайдер*). For established technical terms with no natural Ukrainian
  equivalent, transliterate into Cyrillic so they inflect cleanly (*ранер*,
  *фікстура*, *локатор*, *воркер*, *таргет*, *бандл*, *снепшот*, *трейс*,
  *мокати*, *комітити*).
- Avoid calques and Russianisms: *застосунок*, not *додаток*; *є*, not
  *являється*; *цей*, not *даний*; *брати участь*, not *приймати участь*;
  *знімок екрана*, not *знімок екрану*.
- Write *веб* as one word with the following noun (*вебзастосунок*,
  *вебсторінка*, *вебрушій*). Hyphenate a Latin-script prefix joined to a
  Ukrainian word (*debug-збірка*, *release-збірка*, *preview-розгортання*,
  *CI-сервіс*).
- Headings and titles use sentence case, like the English pages: only the first
  word and proper names start with a capital letter.
- Use Ukrainian quotation marks («…») in prose. Inline code and code blocks
  keep their own quotes.
- Do not use en dashes or em dashes anywhere in the locale, even though
  standard Ukrainian typography uses em dashes. Use a colon, comma,
  parentheses, or a plain hyphen (`-`) instead, and write numeric ranges with
  words («від 10 до 16 секунд», «від 285 до 335 мс»).
- Keep product, package, and API names in English and Latin script: e2e,
  Playwright, `@e2e-dev/web`, MCP, CI, GitHub Actions, Pixel Fold. Keep literal
  CLI option labels such as **None** and **Skip for now** unchanged so readers
  can match them in the terminal.
- Never inflect inline code or Latin-script names. When a sentence needs a
  case, place a Ukrainian noun in front («у сервісі GitHub Actions», «на
  сервері MCP», «у файлі `e2e.config.ts`»). Keep Latin acronyms (CI, MCP, API,
  SDK, CLI, URL, PR, UI, E2E) uninflected and keep multi-word terms that
  Ukrainian developers leave in English as is (`pull request`, `bug bash`,
  `deep link`, `test ID`, `keychain`, `workflow`).
- Distinguish *goal* («ціль») from *target* («таргет») consistently, since both
  appear on the same pages.
- Translate *route* as «перехоплення запитів» or «мокування запитів», not
  «маршрут», when referring to network mocking.
- Translate prose in exported prompt strings (such as `setupPrompt` on
  `quickstart.mdx`), keeping commands, code, and URLs unchanged. Code inside
  fenced blocks stays unchanged, including comments and prompt strings.
- Link to a reference page as «довідка з X» or «документація API X» in prose.

| English | Ukrainian |
| --- | --- |
| app, application | застосунок |
| open source | з відкритим кодом |
| test, test suite | тест, набір тестів |
| end-to-end test | end-to-end тест (E2E) |
| agent, agentic | агент, агентний |
| agent step | крок агента |
| agent turn | хід агента |
| deterministic | детермінований |
| engine | рушій |
| runner | ранер |
| fixture | фікстура |
| harness | харнес |
| locator | локатор |
| matcher | матчер |
| step | крок |
| assertion, check | перевірка |
| statement (text of an assertion) | твердження |
| target | таргет |
| goal | ціль |
| cache, replay cache | кеш, кеш відтворення |
| strict cache mode | суворий режим кешу |
| cache miss | промах кешу (cache miss) |
| hand-off (to the agent) | передача керування агенту |
| replay (verb) | відтворювати |
| executor | виконавець (executor) |
| provider | провайдер |
| hosted browser, hosted device | хмарний браузер, хмарний пристрій |
| device | пристрій |
| simulator, emulator | симулятор, емулятор |
| real device | фізичний пристрій |
| lease (a device) | бронювання, бронювати |
| launch arguments | аргументи запуску |
| permissions | дозволи |
| warm-up | прогрів (warm-up) |
| daemon | демон (daemon) |
| bundle, bundle ID | бандл, ідентифікатор бандлу (bundle ID) |
| test ID | test ID |
| tap, swipe | тап, свайп |
| keychain | keychain |
| deep link | deep link |
| worker | воркер |
| retry | повторна спроба |
| flaky test | нестабільний тест (flaky); *flaky* як статус звіту |
| attempt | спроба |
| run (noun) | запуск |
| trace | трейс |
| artifact | артефакт |
| report, reporter | звіт, репортер |
| credentials | облікові дані |
| secret | секрет |
| redact | маскувати |
| session | сесія |
| judge | модель-суддя (`judge`) |
| verdict | вердикт |
| decision model | модель прийняття рішень |
| coding agent | кодинг-агент |
| skill | скіл |
| plugin | плагін |
| prompt | промпт |
| wizard | майстер налаштування |
| bug bash | bug bash |
| visual testing | візуальне тестування |
| self-healing tests | самовідновлювані тести |
| user flow | сценарій користувача |
| flow | сценарій |
| pull request | pull request |
| commit (verb) | комітити, закомітити |
| mock | мок, мокати |
| config, configuration | конфіг, конфігурація |
| debugging | налагодження |
| screenshot | знімок екрана |
| snapshot | снепшот |
| semantic tree | семантичне дерево |
| viewport | в'юпорт |
| headed, headless | режим headed, режим headless |
| hydration | гідрація |
| origin | origin |
| build, debug build, release build | збірка, debug-збірка, release-збірка |
| deploy, deployment | розгортання, деплой |
| staging, production | staging, продакшн |
| preview (deployment) | прев'ю-деплой (preview) |
| timeout | тайм-аут |
| CI job, workflow | завдання (job), workflow |
| shard, sharding | шард, шардинг |
| required check | обов'язкова перевірка |
| merge queue | черга злиття |
| affected tests | тести, яких стосується зміна |
| exit code | код виходу |
| subscription | підписка |
| sign in | увійти |
| dev server | dev-сервер |
| reference (docs) | Довідник (вкладка, картки); довідка з X (текст) |
| Next (closing heading) | Що далі |
