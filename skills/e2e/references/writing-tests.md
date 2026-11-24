# Writing tests

## Contents

- A complete file
- Structure: one describe, arrange-act-assert, one behavior
- Registration
- Fixtures
- Locators
- expect
- Sign-in sessions
- Start near the screen under test
- The browser fixture (browser only)
- Habits

## A complete file

```ts
// tests/todos.e2e.ts
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('todos', { tags: ['todos'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/todos');
  });

  const labels = { list: 'Todos', remaining: 'Remaining' };
  const title = 'Write the release notes';
  const other = 'Book the venue';
  const addTodo = 'Add a todo named {title}';

  test('adds a todo to the list', async ({ agent, screen }) => {
    await agent.act(addTodo, { params: { title } });

    await expect(screen.getByRole('checkbox', title)).not.toBeChecked();
    await expect(screen.getByRole('list', labels.list).getByRole('listitem')).toHaveCount(1);
    await expect(screen.getByRole('status', labels.remaining)).toHaveText('1 remaining');
  });

  test('marks a todo as done', async ({ agent, screen }) => {
    const todo = screen.getByRole('checkbox', title);
    await agent.act(addTodo, { params: { title: other } });
    await agent.act(addTodo, { params: { title } });
    await todo.waitFor();

    // the second todo shown: this list adds new todos at the end
    await agent.act('Mark {title} as done', { params: { title } });

    await expect(todo).toBeChecked();
    await expect(screen.getByRole('checkbox', other)).not.toBeChecked();
    await expect(screen.getByRole('status', labels.remaining)).toHaveText('1 remaining');
  });

  test('ignores an empty submission', async ({ screen }) => {
    // An exact interaction: the empty submit is the point of the test.
    await screen.getByRole('button', 'Add').tap();

    await expect(screen.getByRole('list', labels.list).getByRole('listitem')).toHaveCount(0);
  });
});
```

The agent drives the flow. A passing `agent.assert` or locator matcher
checks the outcome and confirms the preceding actions for replay. `screen`
actions are for exact interactions and short, stable flows; a goal takes
its values in `params`. Files match the config
`tests` glob, default `tests/**/*.e2e.ts`. In a browser every test starts
from a fresh context with no page open, so it calls `app.open()` first; on a
device a test that skips `app.open()` starts where the previous test left
the app.

## Structure: one describe, arrange-act-assert, one behavior

Write every test in this shape. When a test fails, its title alone should
say what broke, with no debugging needed, unless the arrange or act steps
themselves failed or the app changed under them.

- **One top-level `describe` per unit or feature.** Name it after the
  feature (`describe('todos')`, `describe('checkout')`) and put every test
  for it inside, with the hooks those tests share. A file holds one feature.
  Nest a `describe` only to share a hook or an option (a `session`,
  `agentContext`, `tags`) with some of its tests. Setup tests are the
  exception: `test.setup` must be top-level, outside any `describe`.
- **Arrange, act, assert, in that order.** Put shared arrange hooks first
  inside `describe`, before constants and tests. Put `beforeAll` before
  `beforeEach` when the suite uses both. Keep the act and assertion
  blocks in the test, separated by a blank line.
  - Arrange reaches the state the behavior starts from. Use `beforeAll`
    for setup once per suite realm that only needs worker fixtures. Use
    `beforeEach` for each test's starting state, including opening a
    browser page. Declare a saved session when a test needs that state
    and use a fixture for data creation and cleanup. Keep one-off
    setup in the test or its fixture. End UI setup with a wait for the state it reached
    (`locator.waitFor()`, `agent.waitFor`). A setup goal that passed
    without doing its job then fails there, not at the outcome check, and
    the wait confirms the setup goals for the replay cache.
  - Act pursues the test's one goal. Use precise `screen` actions when
    an interaction matters to the requirement. In `agent.act`, spell out
    the fields, choices, buttons, and order when they matter to the flow.
    Start with one call. For a long form or wizard, split at a screen
    transition only when a later step needs a specific state. Say why
    in the test, wait for that state, and verify the full flow in a run.
    When the act leaves a screen, wait for the state it needs first.
    Let a locator matcher poll for the outcome. Before `agent.assert`,
    wait for any state the agent needs to see.
  - Assert holds every `expect`, `expect.poll`, and `agent.assert`, and
    nothing after them. In a test body, no check sits in arrange or act.
    A state the test needs before it can go on is a wait on a locator
    narrowed to that state, such as
    `balance.filter({ hasText: /^\$10\.00$/ }).waitFor()`,
    `screen.getByRole('switch', 'Lock card', { checked: true }).waitFor()`,
    or `heading.waitFor({ state: 'hidden' })`. A failed wait reports
    `LOCATOR_NOT_FOUND` and a failed check `ASSERTION_FAILED`, so the
    error code distinguishes the wait from the assertion. Use the failed
    step to tell which state was missing. Wait for a
    starting value only when the outcome check depends on it. A setup
    test's `session.save` is bookkeeping and comes after its check.
- **One behavior and one goal per test.** A test verifies one outcome. Its title
  names it: `'marks a todo as done'`, not `'todos work'` or `'adds and
  completes a todo'`. An "and" in a title usually means two tests. Several
  assertions are fine when they all check that one outcome (the count and
  the remaining label after an add). A second behavior is a second test.
  When it starts from the first one's result, its arrange block repeats the
  first one's act (or seeds the result through the API) rather than
  chaining both into one test.
- **Prove the change, on the record the test changed.** Before you write a
  check, ask what wrong behavior would still pass it: a step that did
  nothing, a deleted record, a change to the wrong record, a value that is
  gone after a reload. `0 remaining` alone also passes when the todo was
  deleted; the checked checkbox does not. So pick an end value the start
  cannot already show: a spend limit other than the default, a label that
  is absent before the act. A change to the wrong record of a list is the
  next bullet. When the start is known, write the expected
  value as a literal; never compute it from a screen read. Locate every
  check inside the row, card, or dialog of the record the test made, never
  by position such as `.first()`, where another record can match. When the
  promise is that a change is saved, wait for the app to acknowledge it,
  then reopen the record; that wait and the reopen end the act block.
  When the promise is about what is stored and the project gives you a way
  to read stored state, an API or a helper, check that too, by id and
  every field the requirement names: a record stored again under a new id,
  or values swapped between rows, can look right on screen. That read adds
  to the screen check, never replaces it. Check only what the requirement
  promises: leave out a list's order, a timestamp, or wording it does not
  name, so a legitimate change keeps the test green. The title claims only
  what the assert block checks.
- **Act on the second item shown, never the first.** When a test removes,
  edits, renames, completes, or toggles one item of a list (a row, a line,
  a card), its arrange block adds two items, and its act picks the second
  item the list shows. In a list that shows the newest item first, that is
  the item added first. Its assert block then checks that the first item is
  still there, unchanged. The first item is the easy pick and the wrong
  one: an app that always changes the first row passes a test that acts on
  the first row.

  ```ts
  // Bad: deletes the first todo, so an app that always deletes row 1 passes.
  await agent.act(addTodo, { params: { title: other } });
  await agent.act(addTodo, { params: { title } });
  await screen.getByRole('button', `Delete ${other}`).tap();

  // Good: deletes the second todo (this list adds new todos at the end),
  // then checks the first one is still there.
  await agent.act(addTodo, { params: { title: other } });
  await agent.act(addTodo, { params: { title } });
  await screen.getByRole('button', `Delete ${title}`).tap();

  await expect(screen.getByRole('checkbox', title)).toHaveCount(0);
  await expect(screen.getByRole('checkbox', other)).toBeVisible();
  ```

  Before you run the file, find each test that acts on one item of a list
  and check that it acts on the second item shown.
- **Verify the state the action should leave behind.** When success
  includes a saved record, wait for the confirmation before leaving the
  first screen. Open the receipt, history, or detail page afresh and
  compare its values with the original test inputs. A confirmation can
  appear even when the app saves different data.
- **Check delivery on the recipient's screen.** Keep a separate recipient
  session open while the sender acts. Scope the assertion to the new,
  run-unique message. If the requirement says once, assert one match
  for that message and repeat the check after reopening history when
  history is part of the promise. Older messages can stay on either screen.
- **Own every record the test needs.** A fixture can create a target and a
  similar neighbor for each test using the same setup code. Keep their
  returned IDs and original values. After acting, use fresh reads to check
  the target's change and the neighbor's unchanged fields. Wrap the
  creation and `use()` in `try`/`finally` and delete every record created
  so far in the `finally`, so a setup error after the first record and a
  failed assertion leave no records behind.
- **Prove a refusal leaves state unchanged.** A refusal message can
  accompany a write. If the requirement promises a visible refusal and
  no persisted change, check each explicitly. End the message test on
  the refusal. For the fresh-read test, seed the target and other records,
  try the action, wait for its refusal, and reopen the page. Wait for a
  readiness signal independent of the outcome, such as the list finishing
  loading. Then assert that the target and other records are still present
  and unchanged, using their identities and a fresh persisted-state read
  where available. If the requirement includes a retry, repeat the action
  on that reopened state and verify its outcome as well.
- **Each test owns its starting state.** In a browser every test starts in
  a fresh context. With `session`, it starts from what the setup test
  saved, cookies, local storage, and IndexedDB, never from what an earlier
  test changed. So two tests on one session do not see each other's
  changes to that state. Data the app keeps on its server is shared by
  every test and every run. Create what a test changes there in a
  `test.extend` fixture with a run-unique name, and delete it in that
  fixture after `use()`, which runs after a failure too. With no API or
  seed helper in reach, the fixture still owns the record: it takes `app`
  and `screen`, creates the record through the UI before `use(name)`, and
  after `use()` opens the list and deletes it by that name with the app's
  own delete control. Never clean up at the end of a test body: a failed
  check skips it, and the stray record can satisfy the next run's checks. On a device the app keeps its
  data from test to test: reset it with `app.clearState()` (on the iOS
  simulator also `device.clearKeychain()` when the app keeps its sign-in in
  the keychain) and seed what the test needs the same way. An app whose backend runs in the page, on
  IndexedDB or local storage, keeps its data in the session too, even when
  its requests go to a URL. When you are not sure which kind you have, run
  the test that reads the state alone: if it passes, it needs no earlier
  test and no `serial`. Nothing branches or skips on what the app shows, in
  a test, a helper, or a fixture's teardown (a skip on the environment or
  config, before the first step, is fine), as in
  `if (await card.isVisible())`, `if ((await rows.count()) > 0)`, or
  `test.skip(await card.isVisible())`. `count()` and `isVisible()`
  read the screen as it is now without waiting, so right after a
  navigation they see a list that has not loaded. Give the test the state
  it needs instead, and make a teardown delete what it owns without
  asking: a test that deletes the record itself gets a fixture with no
  teardown. `serial: true` is for a journey whose steps are meant to
  chain, not a fix for a test that fails alone. Any one test passes when
  you run it alone, by `file:line`, twice in a row.
- **Name what the tests repeat.** Inside the shared `describe`, define a
  selector input, test value, or prompt text that more than one step or
  test uses in a plain object or constant, and keep a single-use one
  inline. In a hook or test, bind those inputs to
  the current `screen` fixture. Keep selectors that need runtime data,
  such as a fixture record ID, close to that data. Bind a repeated locator
  to a local `const`. As the spec grows or another spec needs the same
  definitions, export them from a feature-local TypeScript file and import
  them in the specs. Name prompts for what they ask the agent to do or
  verify. Pass variable values as named `params` so the placeholders and
  their inputs are easy to match at the call site.
  Use small helpers for shared actions and a [page object](https://e2e.com/docs/page-object-model)
  when several specs drive the same screen.
- **Pick each step and each check by what it must prove.** Use an
  `agent.act` instruction for a long or changing path when the requirement
  is about the result. A value the goal needs goes in its `params`, and a
  value that changes every run goes through `unique()` so the replay cache
  still matches. Use `screen` lines for a short, stable flow, for an
  interaction that is itself the point of the test, such as `ignores an
  empty submission` above, for a sign-in form in a setup test, and in a
  project with no model. Use `agent.assert` alone when the relevant screen
  gives the agent evidence for the full outcome. Specify what to judge,
  including any exact value the outcome requires. Choose a locator matcher
  when it gives a clearer signal, such as an exact count or field state.
  Add a second check when it proves another part of the outcome. The replay
  cache never skips an assertion. A file of
  `screen` lines only suits a short, stable flow; for anything else, weigh
  it with `/agentic-vs-deterministic` in the docs.

For the replay cache (topic `agent`), a passing locator or engine matcher,
`locator.waitFor`, `agent.assert`, or `agent.waitFor` confirms every
`agent.act` before it; `expect.poll` and a plain-value `expect` confirm
nothing. End with a check that confirms the outcome. When the test fails, every goal
after the last passing confirmation runs live again on the next run: the
arrange block's closing wait keeps the setup goals cached while you fix the
act or the assertions.

## Registration

`test` registers everything, and `describe`, `beforeEach`, `afterEach`,
`beforeAll`, and `afterAll` are also top-level imports of the same functions
(`import { describe, beforeEach } from 'e2e'`; `@e2e-dev/web`,
`@e2e-dev/mobile`, and `@e2e-dev/desktop` export `test`, `describe`, and the hooks typed with their fixture; a
`test.extend()` chain registers hooks that see its fixtures through
`test.beforeEach`). Everything registers at import, so a `describe` body is
synchronous (`async` is a `COLLECTION_ERROR`).

```ts
test('title', async ({ app, screen }) => {});
test('title', { tags: ['smoke'], retries: 2, timeout: 60_000 }, async ({ app }) => {});
describe('group', { tags: ['billing'] }, () => { /* tests and hooks */ });
describe('checkout flow', { serial: true }, () => { /* ordered, shared app state */ });
beforeEach(async ({ app }) => {});     // per attempt, with test fixtures
afterEach(async ({ screen }) => {});   // runs after failures too, with its own cleanup budget
beforeAll(async ({ platform }) => {}); // per suite realm, worker fixtures only (device, app, screen on mobile)
afterAll(async () => {});
test.skip('later', async () => {});
test.only('focus', async () => {});         // local only: CI fails with ONLY_IN_CI
test.skipIf(process.platform === 'win32')('watcher', async () => {}); // condition read at collection: truthy registers it skipped, as { skip: true }
test.runIf(process.env.CI)('ci only', { tags: ['ci'] }, async () => {}); // test.skipIf(!condition)
test.each([{ user: 'Ada' }, { user: 'Grace' }])('signs in as $user', async ({ user }, { app }) => {}); // one test per row; rows that are all arrays are spread: (a, b, { app }), any other table passes each row whole; the fixtures are destructured after the row; titles take $key, %s, %i, %#
test.for([['standard', '5.00']])('ships %s for %s', async ([speed, price], { app }) => {}); // test.each without the spread: (row, { app })
test('conditional', async () => { test.skip(await onlyOneOrg(), 'nothing to switch to'); }); // throws: the body stops here, reported skipped; call it before the first step
test('later', async () => { test.skip('waiting on the API'); }); // bare skip from the body
test.fixme('not yet', async () => {}); // test.skip's three forms; reported skipped with cause "fixme" and reason "fixme", or "fixme: <reason>" from test.fixme(reason) or test.fixme(cond, reason) in a body
test('big import', async () => { test.setTimeout(180_000); }); // body or beforeEach: the attempt's timeout, counted from its start; in beforeAll: that hook's own
test('slow sync', async () => { test.slow(); }); // triples the timeout in force, once per attempt; test.slow(condition, reason) only when true
test.fail('known gap', async () => {}); // expected to fail: a test failure passes it, a pass fails it with UNEXPECTED_PASS
test('gap on web', async ({ platform }) => { test.fail(platform === 'web', 'known gap'); }); // marks, does not throw; the body runs on
describe.fail('legacy', () => {}); // every test inside expected to fail; a reason: describe('legacy', { fail: 'reason' }, fn)
test.setup('sign in', { sessions: ['admin'] }, async ({ app, screen, session }) => {}); // see Sign-in sessions
const wsTest = test.extend<{ ws: Ws }>({ ws: async ({ browser }, use) => { await use(await seed()); await drop(); } });
wsTest('uses the workspace', async ({ ws }) => {}); // code after use() is teardown, runs after failures too
const dbTest = test.extend<{}, { db: Db }>({ db: [async ({}, use) => { await use(await startDb()); }, { scope: 'worker' }] });
dbTest.beforeAll(async ({ db }) => { await db.seed(); }); // one db per worker, torn down when the worker ends
```

A setup test cannot skip from its body (`INVALID_ARGUMENT`), and neither a
setup test nor a serial member can call `test.fail`. `test.fail` covers test
failures and timeouts only: an infrastructure error such as `ENGINE_FAILURE`
or a blocked agent verdict still fails the test.

| Option | Default | Notes |
| --- | --- | --- |
| `timeout` | `config.timeout`, 120 s | Covers `beforeEach` and the body. |
| `retries` | `config.retries` | 0 to 10; a serial group's value applies to its members. |
| `tags` | `[]` | Distinct, non-blank, no comma or edge whitespace (`'Login Form'` is fine); union across layers. `--tag smoke` selects, `--tag-mode all` requires every tag. |
| `skip` | unset | `true` or a reason string. |
| `fail` | unset | `true` or a reason string: expected to fail, as `test.fail`. On a group, marks every test in it; not on setup tests or on, inside, or around a serial group. |
| `platforms` | unset | Only targets with these platforms, e.g. `['ios']`. |
| `requires` | `[]` | Engine capabilities, e.g. `['browser']`; missing ones skip the test at selection rather than failing it with `UNSUPPORTED_CAPABILITY`. |
| `session` | unset | Restore state saved by a setup test. |
| `agentContext` | unset | Extra context for `agent.*` calls in this test or group. |
| `agent` | the run's agent | A configured name (`agents.<name>`) or a list run once per agent; `--agent` narrows the list, a setup test takes one name. Innermost wins; `agent.act(..., { agent })` names another for one call. |
| `trace`, `video` | the target's | `'off'`, `'on'`, `'retain-on-failure'`, `'on-first-retry'`, `'on-all-retries'`: whether the test keeps a trace page, which attempts record video. Innermost wins over `--trace` / `--video`, the target, and the config; video where the engine cannot record is `UNSUPPORTED_ARTIFACT` for the run. |
| `serial` | `false` | Groups only. Members share app state, run in order on one worker, retry as a whole, and take the group's `trace` and `video`. |

Serial members cannot set `retries`, `trace`, `video`, `session`,
`platforms`, `requires`, `skip`, `fail`, or `only`, nor can a nested `describe` set
`trace` or `video`; nesting serial groups is a `COLLECTION_ERROR`.

Hooks nest: outer `beforeEach` first, inner `afterEach` first. `beforeAll`
reruns per retry and per serial group (each a fresh module realm) on the
test timeout; `afterAll` runs on `config.cleanupTimeout`. A failing
`beforeAll` is a `HOOK_FAILED` run error skipping every test in its scope.
`beforeAll` and `afterAll` get worker fixtures only: `platform`, worker
fixtures from `test.extend`, and on mobile `device`, `app`, and `screen`
(a device keeps its state between tests). On web, `browser`, `app`, and
`screen` are test fixtures, so UI setup goes in `beforeEach`. Naming a test
fixture in a suite hook is a `COLLECTION_ERROR` naming it. On mobile a suite
hook that names none of `device`, `app`, `screen` opens no device attempt; when no device
attempt can open for the hooks or the run was interrupted, they still run and
reading `device`, `app`, or `screen` throws the reason.

## Fixtures

Find the module that exports the project's fixture-aware `test`. Choose
the spec's final path before writing the import, then resolve the import
from the spec's directory. Run that spec after adding or moving it and
confirm the runner collects and executes the intended test.

Fixtures are set up on demand. A test body, a hook, and a fixture function
name what they use by destructuring their first parameter
(`async ({ app, screen }) => {}`), a `test.each` or `test.for` body the one
after its row; `async (fixtures) => {}`, `async (_, use)`,
a rest property, and a bound function (`fn.bind()`) are `COLLECTION_ERROR`, and a fixture that needs nothing
takes `({}, use)`. A test sets up the `test.extend` fixtures its body and its
`beforeEach` and `afterEach` hooks name, and the ones those fixtures name
(same `extend` call or an earlier one, any order; a cycle is
`COLLECTION_ERROR`). A fixture nothing names does not run: one that exists
for its side effect takes `[fn, { auto: true }]`, set up for every test, or
`[fn, { scope: 'worker', auto: true }]`, once per worker. A name the target
has no fixture for fails the run at collection with the file and line; a test
skipped on that target (`platforms`, `requires`, `test.skipIf`) is not
checked there. An `afterEach` that names a fixture whose setup failed is
skipped. A fixture named like one the `test` already has, built-in ones
included, extends it (`app: async ({ app }, use) => { await app.open('/x');
await use(app); }`, no type argument): inside it the name is the previous
value, everyone else gets what it passes to `use`, and it keeps that
fixture's type, scope, and `auto` (`device` on mobile: once per worker,
`beforeAll` gets it; a different `scope` or `auto` is `COLLECTION_ERROR`). A worker
fixture (`[fn, { scope: 'worker' }]`, second type argument of `extend`) is
set up once per worker and target by the first test or suite hook that names
it, torn down when the worker ends, and sees worker fixtures only. Declare it in a module the test files import: a test
file reloads after a failure and for each serial group and setup test, and a
worker fixture it declares gets a new
instance while the old one stays set up until the worker ends.

`app` (`App`) and `screen` (`Screen`): always. `agent` (`Agent`): needs a
configured model, else `MODEL_UNAVAILABLE` (topic `agent`). `platform`
(`string`): always, hooks included; `web`, `ios`, `android`, or an engine's
label. `browser` (`Browser`): browser targets, import `test` from `@e2e-dev/web`.
`device` (`Device`): device targets, import `test` from `@e2e-dev/mobile`.
`desktop` (`Desktop`): desktop targets, import `test` from `@e2e-dev/desktop`.
`session` (`SetupSession`): only in `test.setup`.

### app

- `baseUrl` (`string | undefined`): the target's app URL with the run's
  port and no trailing slash (`${app.baseUrl}/api/users`); `undefined` when
  the target declares no `app.url`. `string` with `test` from `@e2e-dev/web`.
- `open(path?)`: opens the target's `app.url`, a relative path, or an absolute
  http(s) URL. On a device it relaunches the pinned app, and a path opens as
  a link in it only when the target declares `app.linkBase`.
- `back()`: one history step back.
- `restart()`: recreates the context keeping persisted state (a restored
  session included), then reopens the base URL.
- `clearState()`: clears cookies and storage, recreates the context, reopens
  the base URL.
- `screenshot(label?)`: saves a redacted screenshot artifact and returns its
  absolute path; the `list` summary names the first 10 under `Screenshots`. It masks
  secure fields only (see Sign-in sessions).
- `startRecording({ name? })`, then `stopRecording()`: records one span and
  returns its videos (`path` or hosted `url`). Fails while the test's
  `video` records: set `{ video: 'off' }` on the test.

`clearState()` is `UNSUPPORTED_CAPABILITY` with `connect.reconnectEndpoint`
or an attempt-scoped browser provider; on a device with no pinned `app`, both
methods are.

## Locators

`screen.getBy*` builds a lazy query, resolved only by an action, read, or
assertion. Every query also exists on a locator, scoped to its subtree.

For a collection check, start at the owning list or table and query only
its items or rows. When the requirement names the whole collection, check
every row in that container, including duplicates. If order can change,
sort copies before comparing the complete observed and expected lists.

| Query | Matches |
| --- | --- |
| `getByRole(role, name?, { exact?, checked?, disabled?, selected?, expanded?, pressed?, level?, visible? })` | Semantic role, optionally by accessible name (`getByRole('button', 'Save')`; the object form `{ name }` works too) and state (`level`: heading level 1 to 6). First choice. |
| `getByLabel(text, { exact?, visible? })` | Form controls by label. |
| `getByPlaceholder(text, { exact?, visible? })` | Inputs by placeholder. |
| `getByText(text, { exact?, visible? })` | Visible text. |
| `getByDisplayValue(value, { exact?, visible? })` | Inputs by current value; on the web it cannot scope child queries or be a `filter({ has })` or `filter({ hasNot })` target. |
| `getByTestId(id, { visible? })` | `data-testid` on the web (or `web({ testIdAttribute })`), accessibility identifier or resource id on a device (React Native `testID`, SwiftUI `.accessibilityIdentifier`, Compose `testTag` with `testTagsAsResourceId` on Android, Flutter `Semantics(identifier:)`, .NET MAUI `AutomationId`, NativeScript `testID`); a string matches the whole id, a RegExp tests it; on Android the `<package>:id/` prefix may be left off. Last resort. |

Roles: `button`, `link`, `textbox`, `searchbox`, `combobox`, `listbox`,
`option`, `checkbox`, `radio`, `radiogroup`, `switch`, `slider`, `spinbutton`,
`progressbar`, `meter`, `image`, `heading`, `tab`, `tablist`, `tabpanel`,
`menu`, `menubar`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `toolbar`,
`tooltip`, `tree`, `treeitem`, `list`, `listitem`, `table`, `grid`, `row`,
`rowgroup`, `rowheader`, `cell`, `gridcell`, `columnheader`, `separator`,
`group`, `article`, `figure`, `form`, `status`, `alert`, `dialog`,
`alertdialog`, `main`, `navigation`, `banner`, `contentinfo`, `complementary`,
`region`. The union is closed (anything else is a type error); `img` aliases
`image`; a role the platform lacks (`tooltip` on a phone) matches nothing.
On the web a `contenteditable` host is a `textbox` for the agent and takes
`fill`; from a test use `getByLabel`, `getByTestId`, or `role="textbox"` on
the host.

The second argument to `getByRole` is the element's accessible name.
For visible text inside an unlabelled list item or status, use
`getByRole('listitem').filter({ hasText: message })` or scope a
`getByText(message)` query to the right part of the screen.

Text matching is exact after whitespace normalization (whole string,
case-sensitive) for a `getByRole` name, `getByLabel`, `getByPlaceholder`, and
`getByText`: `name: 'Save'` misses `Save changes` (unlike Playwright). A
missed query makes a negated assertion pass, so check it positively.
`getByText` and `getByLabel` return the innermost match, so a container
echoing its child does not count twice. `exact: false` is a case-insensitive
substring; a `RegExp` matches as written.

- Exactly one match per action, read, or assertion. Two fail at once with
  `LOCATOR_AMBIGUOUS`; at zero, actions and reads poll until the action
  timeout then `LOCATOR_NOT_FOUND`, assertions until the assertion timeout
  then `ASSERTION_FAILED`. Exceptions:
  `toHaveCount`, `toBeVisible`, `toBeHidden`, `toBeAttached`, list-form
  `toHaveText` and `toContainText`, `isVisible()` (false at zero),
  `isHidden()` (true), `count()`, `all()`, `allTextContents()`.
- Narrow with `filter({ hasText })` (a case-insensitive substring, unlike a
  query), `filter({ hasNotText })` to exclude matching subtree text,
  `filter({ has: locator })`, `filter({ hasNot: locator })`, `first()`,
  `last()`, `nth(i)`, or scoping under another locator. Any other `filter`
  key (`visible`) or an empty `filter({})` is `INVALID_LOCATOR`. `a.or(b)`
  matches either, still strict: add `first()` when both may match. Both
  locators must come from the same screen and attempt. Web branches need
  identical literal frame-selector chains; display-value branches cannot be
  composed.
- `visible: true` drops nodes the page hides (a closed drawer) before the
  exactly-one rule. Visibility is what renders, as `toBeVisible()` reads it:
  an `aria-hidden` spinner that paints is visible, so `toBeHidden()` waits
  for it to go. A closed `<details>` body and content under
  `content-visibility: hidden` are hidden through shadow roots and slots too,
  unless the page's CSS still shows them.
- On the web, queries reach open shadow roots and closed roots attached with
  `attachShadow`, not declarative closed roots. `browser.locator(css)`,
  `frameLocator`, and `filter({ hasText })` stop at a closed root; query the
  text inside or filter with `has`.
- `screen.scrollUntilVisible(locator, { direction?, momentum?, timeout? })`
  scrolls the viewport (`down`, `slow` by default) until the locator resolves
  visibly, else `LOCATOR_NOT_FOUND`; on a locator it scrolls that node.

### Actions

Each action resolves one node, waits up to `config.actionTimeout` (30 s, or
`{ timeout }`) for it to be actionable, and does one thing: `tap()` (alias
`click()`), `doubleTap()` (alias `dblclick()`), `secondaryTap()` (each takes
`{ modifiers: ['Shift'] }`), `longPress({ duration? })`
(100 to 10000 ms; default 500 on the web, 1000 on a device),
`fill(value | Secret)`, `pressSequentially(text, { delay? })`, `clear()`,
`press(key)`, `check()`, `uncheck()`,
`selectOption(label | { label } | { value } | { index })` (one option; an
array is `INVALID_ARGUMENT`), `focus()`, `blur()`, `hover()`, `setInputFiles(files)`
(paths relative to the project root, or `{ name, mimeType, buffer: Buffer }` payloads, singly or as an array; `[]` clears; a missing path, or one under a directory the runner cannot search, is `INVALID_ARGUMENT`), `dragTo(locator)`, `scrollIntoView()`,
`swipe({ direction, momentum? })`. Web only, `UNSUPPORTED_CAPABILITY` on a
device: `blur`, `secondaryTap`, `selectOption`, `setInputFiles`, `scrollIntoView`,
and `modifiers`.

`fill` sets the value with no key events; when the app reacts to keystrokes
(autocomplete, a masked input) use `pressSequentially`, which focuses the
field and types one character per `delay`, plain string only (a `Secret` is
`INVALID_ARGUMENT` and goes through `fill`).

Coordinates are CSS pixels, for what the tree does not list: `tap({ position:
{ x, y } })` offsets from the node's top-left corner inside its border (with `modifiers` it is
`INVALID_ARGUMENT`), `screen.tapAt({ x, y })` taps a viewport point,
`screen.doubleTapAt({ x, y })` double-taps a viewport point,
`screen.swipe({ from, to, duration? })` swipes along a path,
`screen.swipe({ direction, momentum? })` swipes the viewport. Viewport
points also take percentages from `'0%'` through `'100%'`, rounded to the
nearest pixel: `{ x: '50%', y: '50%' }`. Prefer a locator; a point moves with
the layout.

### Reads

`textContent()`, `inputValue()`, `getAttribute(name)`, `isEnabled()`,
`isDisabled()`, `isChecked()`, and `boundingBox()` wait for one match until
the action timeout, then read once with no retry for a value. `isVisible()`,
`isHidden()`, and `count()` answer at once. `all()` gives one
`nth(i)` locator per current match and `allTextContents()` every match's
text, both `[]` at zero. Text is the rendered text, whitespace collapsed: on
the web what `innerText` reads (`text-transform` applies, `display: none`
drops out, `<br>` is a space); `toHaveText` reads the same. `isChecked()` on a
node that cannot be checked (a button), and `inputValue()` on one that holds
no value (a heading), throw `ACTION_FAILED`. `waitFor({ state?: 'attached' | 'detached' | 'visible' | 'hidden', timeout? })` waits
within `actionTimeout`, else `LOCATOR_NOT_FOUND`. For a value that has to
settle use `expect`, not a read. Reading a secure field's value or
attributes is `POLICY_DENIED`, as is `toHaveAttribute` on one, negated too.

`screen.tree()` returns the whole screen as the agent reads it (one node
per line, secrets redacted) and `screen.debug()` prints it to the test's
output. Both read once without waiting. A locator does not have them, and
a frame throws `INVALID_ARGUMENT`.

## expect

`expect(locator)` polls up to `config.assertionTimeout` (5 s) or
`{ timeout }`; `.not` inverts and passes once the negation has held 1 s
continuously, or for the whole `timeout` when that is shorter, so it never
returns sooner. `expect(locator, message?)`, `expect(screen, message?)`, and
their `expect.soft` forms open each assertion failure with the message.
`expect(value, message?)` is synchronous.
Value matchers such as `toMatchObject` check a value and return `void`.
Read a response into a variable, assert on that variable, then use its
properties. Use `toMatchSchema` when you need the parsed value returned
by a matcher.
`expect.poll(read, { timeout?, interval?, intervals?, message? })` re-reads until a value
matcher passes (`assertionTimeout` and `[100, 250, 500, 1000]` ms by default, stopping with the
attempt); a throwing read keeps polling, and it is not a report step. A
poll that the body or a hook returns without awaiting is cancelled and fails
that phase with `STEP_NOT_AWAITED`.
Use `intervals: [<ms>]` in place of the deprecated `interval` option.
`timeout: 0` on a locator or fixture action, `waitFor`, a matcher, or
`expect.poll` sets no deadline of its own: the test timeout
(`cleanupTimeout` in `afterEach`) still bounds it, and `expect.poll` with 0
outside a test, hook, or hosted session is `INVALID_CONFIG`. A negative or non-finite `timeout` is
`INVALID_ARGUMENT` (`INVALID_CONFIG` from `expect.poll`); `agent.*` calls
take a positive `timeout` only.

Use `await expect(fn, message?).toPass({ timeout?, intervals? })` when
several assertions must pass together. The block is retried until it
completes without throwing. Use hard assertions inside the block. Keep
inner locator timeouts short. With `.not.toPass()`, the assertion
passes on the first throw or rejection. With `expect.soft(fn).toPass()`,
you can keep a timeout failure and continue the test body.

Set call options to override the corresponding fields in `config.toPass`.
The defaults are the phase deadline and pauses of `[100, 250, 500, 1000]` ms.
Pass a positive `timeout` outside an attempt or hook. In the report, you
can see the steps from each try, including failed steps. At the cutoff,
running steps in a `toPass` try or poll read are cancelled.

The config defaults and hook deadline apply to both `expect.poll` and
`toPass` in `beforeAll`, `afterAll`, and worker fixture teardown. A call
`timeout` above 2147483647 ms is `INVALID_CONFIG`.

`expect.soft(x)` keeps a failure instead of throwing; the attempt fails
after the body with every soft failure listed. If the body then calls
`test.skip`, the attempt still fails, with the skip reason in its `skip`.
A retry that skips after an earlier failed attempt stays skipped; the CLI shows
it under `Skipped After Failure`, and `failOnSkippedFailure: true` in the
config fails the run with exit code 1. The default is `false`.
`expect.any(Class)`, `expect.anything()`, `expect.objectContaining(obj)`,
`expect.arrayContaining(arr)`, `expect.stringContaining(s)`, and
`expect.stringMatching(s | RegExp)` stand in for values inside `toEqual`,
`toMatchObject`, `toContain`, and `toHaveProperty`.

```ts
await expect(screen.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
await expect(browser).toHaveURL('/dashboard');   // relative to the base URL, or a RegExp
expect(order).toMatchObject({ id: expect.any(Number), lines: [{ sku: 'a' }] });
expect.soft(await screen.getByTestId('tax').textContent()).toBe('$8.00');  // kept, body runs on
const users = expect(await response.json()).toMatchSchema(z.array(User)); // any Standard Schema; typed output
```

`toMatchSchema(schema)` takes a synchronous Standard Schema (Zod, Valibot,
ArkType), fails listing every issue by path, and returns the parsed value
typed; prefer it when the app already has a schema for the response.

| Locator matchers | Browser matchers | Value matchers |
| --- | --- | --- |
| `toBeVisible`, `toBeHidden`, `toBeAttached`, `toBeEnabled`, `toBeDisabled`, `toBeEditable`, `toBeChecked`, `toBeSelected`, `toBeExpanded`, `toBeFocused`, `toHaveText`, `toContainText`, `toHaveValue`, `toHaveAttribute`, `toHaveCount`, `toHaveAccessibleName`, `toHaveRole`, `toHaveScreenshot` (also on `screen`) | `toHaveURL`, `toHaveTitle`, `toHaveClass(locator, expected)` | `toBe`, `toEqual`, `toMatchObject`, `toBeTruthy`, `toBeFalsy`, `toBeNull`, `toBeUndefined`, `toBeDefined`, `toHaveLength`, `toHaveProperty`, `toContain`, `toMatch`, `toBeGreaterThan`, `toBeGreaterThanOrEqual`, `toBeLessThan`, `toBeLessThanOrEqual`, `toBeCloseTo`, `toMatchSchema` |

`toHaveText` compares the whole normalized text, `toContainText` a substring
or RegExp, `toHaveValue` a form control's value as is, whitespace included
(it fails on a node with none); on a secure field all three are
`POLICY_DENIED`, never a comparison against `''`. List forms:
`toHaveText(['Alpha', /^Beta/])` needs exactly two matches with those texts
in order; `toContainText(['Alpha', 'Beta'])` needs each entry in a distinct
match, in order, extra matches allowed. `toHaveAttribute(name)` checks
presence, `toHaveAttribute(name, value)` the value; `toBeAttached` waits for
a match, hidden or not; `toHaveClass` compares the whole normalized class
list or tests a RegExp. A failed matcher is `ASSERTION_FAILED`, exit code 1.

Playwright's `{ checked: false }`, `{ enabled: false }`, `{ editable: false }`,
`{ visible: false }`, and `{ attached: false }` flip their matchers, and `{ ignoreCase: true }`
works on `toHaveText`, `toContainText`, `toHaveAccessibleName`,
`toHaveAttribute(name, value)`, and `expect(browser).toHaveURL`. Any other option, `indeterminate` or
`useInnerText` included, is `INVALID_ARGUMENT`, in JavaScript too.

Screenshots: `await expect(screen).toHaveScreenshot('home.png')` compares the
screen, `expect(locator).toHaveScreenshot()` one element's box, against
`<test file>-snapshots/<name>-<target>-<os>.png`, on web, iOS, and Android
alike. Commit the files. The first run writes the file and fails: look at it,
commit it, rerun. A CI run writes nothing into the project and attaches a
missing one at `snapshots/<path>` in the test's results. `--update-snapshots`
(`-u`) writes missing and different files and passes, after an intended UI
change. Options: `threshold`, `maxDiffPixels`, `maxDiffPixelRatio`, `mask`
(locators painted over, for clocks and other changing content), `maskColor`,
`timeout`. A failure attaches `-expected`, `-actual`, and `-diff` images to the
step. Files are per target and OS (`-web-linux.png`): screenshots written on a
Mac never serve Linux CI, so write CI's from a CI job with `-u`.

## Sign-in sessions

Save sign-in state under a name in a setup test, and declare it with
`session`. Selecting a dependent test alone still runs its setup.

For a test of two users interacting, use distinct accounts in separate
sessions. Restore the primary user's named session through `session`.
For the second user, call `launch(web(), options)` from the test with a
fresh engine, then `host.newSession()`. Sign in with that user's test
credentials and check the outcome on the screen of the user who should
see it. See the [chat example](https://e2e.com/docs/core#open-a-host-inside-a-test)
for sign-in and cleanup. Use `newSession({ state })` only with a core
`SessionState` from `saveState()` or `SessionState.import()`.

```ts
// tests/auth.setup.e2e.ts
import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';

test.setup('authenticate as admin', { sessions: ['admin'] }, async ({ app, screen, session, browser }) => {
  const admin = credentials.user('admin');
  await app.open('/login');
  await screen.getByLabel('Email').fill(admin.username);
  await screen.getByLabel('Password').fill(admin.password);
  await screen.getByRole('button', 'Sign in').tap();
  await expect(browser).toHaveURL('/dashboard'); // prove the sign-in worked before saving
  await session.save('admin');
});
```

```ts
// tests/dashboard.e2e.ts
import { describe, test, expect } from 'e2e';

describe('dashboard', { session: 'admin' }, () => {
  test('opens directly when signed in', async ({ app, screen }) => {
    await app.open('/dashboard');

    await expect(screen.getByRole('heading', 'Dashboard')).toBeVisible();
  });
});
```

- Setup tests are top-level, outside any `describe`; exactly one setup saves a given name and the
  body saves every declared name once (`SESSION_CONTRACT` otherwise). Names
  match `[A-Za-z0-9_.-]{1,128}`.
- A session holds cookies, local storage, and IndexedDB for one run,
  encrypted and deleted at cleanup; server state is not part of it.
- Screenshots, the model's and the artifacts', mask secure fields only,
  after a secret fill too. A generic secret in a plain input, or a value the
  app shows anywhere else (a show-password toggle, a toast), is in the image
  and reaches the model provider: use test credentials.
- Credentials live in the config, values in the environment:

```ts
credentials: {
  admin: { username: 'admin@example.test', password: process.env.ADMIN_PASSWORD ?? '' },
},
```

- A static password or secret needs 6 or more code points, else
  `INVALID_CONFIG` at config load, so an unset variable fails every command.
  A function `password` is read at fill time and redacted only from that fill
  on; `username` is always a string.
- `E2E_USER_<NAME>_USERNAME` and `E2E_USER_<NAME>_PASSWORD` override either
  field per run, even over a function; `<NAME>` is the credential name
  uppercased, every character outside `[A-Z0-9]` as `_`. Two credentials (or
  two secrets) mapping to one variable, `svc-a` and `svc_a`, are
  `INVALID_CONFIG`.
- `credentials.user('admin').password` is a `Secret` with no plaintext
  accessor, named `admin.password` to the agent and in reports; `secrets.get()`
  never returns it (separate namespaces). Only `fill()` and `agent.act` params accept it, stringifying it
  is `INVALID_CONFIG`, and `credentials.user()` outside a run throws
  `AUTH_CREDENTIAL_UNAVAILABLE`.
- Any other sensitive value (an API key) is a `secrets` entry,
  `secrets: { 'stripe-key': process.env.STRIPE_KEY ?? '' }`, overridable with
  `E2E_SECRET_STRIPE_KEY`; `secrets.get('stripe-key')` is the same kind of
  handle, fills any editable input, and is redacted by name everywhere the
  runner writes.
- A registered value passed as a plain string (`process.env.STRIPE_KEY` in a
  title, a URL, a locator, an `agent.act` instruction or param) is redacted
  too: reports, step labels, the executor, and the model see
  `<secret:stripe-key>` (and so does the test id, for a value in a title),
  so the agent cannot type it. Pass the handle.

## Start near the screen under test

A test pays for every step before the screen it checks, on every run and on
every rerun while you fix it. A wrong locator at the end of a long flow
reruns the whole flow, then waits out the 30 s action timeout. Begin each
test as close to its screen as the app allows:

- Sign in once in a setup test and declare `session` on the test (Sign-in
  sessions). The setup still runs once per target per run for all selected
  tests that declare its session.
- Open the screen by its path, `app.open('/projects/42/settings')`, not the
  home page and three taps. `observe` over MCP prints the path of the screen
  you reached.
- Create the data the screen needs through the app's API in a `test.extend`
  fixture. Click through a creation flow only in the test that covers it.
  A declared session is restored before fixtures run, so when the app signs
  in with a cookie, its session cookie from `browser.cookies()` signs the
  fixture's requests in. Send only that cookie: the list holds every site's.
  Check the response in the fixture: a
  failed seed then fails there, not 30 s later on a locator. While exploring
  over MCP, a project tool that seeds data (topic `agent`) gets there in one
  `call`.

```ts
import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { z } from 'zod';

const projectTest = test.extend<{ project: { id: string } }>({
  project: async ({ app, browser, request }, use) => {
    // The domain the app sets the cookie on: its host, or `.example.com` for `Domain=example.com`.
    const domain = new URL(app.baseUrl).hostname;
    const session = (await browser.cookies()).find((c) => c.name === 'session' && c.domain === domain);
    if (session === undefined) throw new Error('not signed in: no session cookie for the app');
    const headers = { cookie: `session=${session.value}` };
    const created = await request.post(`${app.baseUrl}/api/projects`, { json: { name: `Project ${Date.now()}` }, headers });
    expect(created.status).toBe(201);
    const project = expect(await created.json()).toMatchSchema(z.object({ id: z.string() }));
    await use(project);
    await request.delete(`${app.baseUrl}/api/projects/${project.id}`, { headers }); // runs after a failure too
  },
});

describe('project settings', { session: 'admin' }, () => {
  projectTest('renames a project', async ({ app, screen, project }) => {
    await app.open(`/projects/${project.id}/settings`); // straight to the screen under test

    await screen.getByLabel('Name').fill('Atlas');
    await screen.getByRole('button', 'Save').tap();
    await screen.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor();
    await app.open(`/projects/${project.id}/settings`); // reopened: the promise is that it is saved

    await expect(screen.getByLabel('Name')).toHaveValue('Atlas');
  });
});
```

On a device there are no sessions. `app.open()` takes a path only on a target
with `app.linkBase` (`linkBase: 'myapp://'` makes `app.open('/projects/42')`
open `myapp://projects/42`); otherwise `device.openLink('myapp://projects/42')`
opens a route, or a sign-in link, in the app.

Grow a test that spans several screens one screen at a time when you have
not checked its steps live: write up to the next screen you have not seen
pass, end it with a temporary check of that screen, run it, then replace
the check with the next part. The finished test keeps only its outcome
checks, in the assert block. A passing locator step takes milliseconds,
and an `agent.act` that a later check confirmed replays from the cache with
no model call. The cache keeps those entries when a later line fails, so
each run pays model calls only for its new part. That holds for a first
attempt with a read-write cache: a retry never replays, and with `CI` set
the cache records nothing by default, so grow the test outside `CI` and
pass `--retries 0` when the config retries. Keep the title and the
goals already written as they are while the test grows: a cache entry
belongs to the test's file and title path and the goal's instruction and
params. A fixture's run-unique value in a goal's params goes in as
`unique(value)` (topic `agent`), or every run misses.

## The browser fixture (browser only)

Prefer `app` and `screen`; `browser` is for what only a browser has, and a
portable suite declares `requires: ['browser']`. Page methods act on the one
active tab; cookies, routes, and `onDialog` cover the whole browser. A tab
the app opens (`target="_blank"`, `window.open`) opens in the background:
the active tab stays where it was. `waitForPopup(() => trigger)` makes the
tab the trigger opens active and resolves with it. When the active tab
closes, its opener is active again, or the tab active most recently when
the opener is gone. `tabs()`, `newTab()`, `tab.activate()`, and
`tab.close()` move between tabs.

- `goto(url, { waitUntil?, timeout? })`, `reload({ timeout? })`,
  `back({ timeout? })`, `forward({ timeout? })`: navigation on the test
  timeout by default; `goto` takes a base-relative path.
- `url()`, `title()`, `waitForURL(url | RegExp, { timeout? })`: reads and a
  URL wait; `waitForURL` matches like `toHaveURL`.
- `locator(css)`: raw CSS or XPath; not portable, a last resort.
- `frameLocator(css)`: a `Screen` scoped to one iframe
  (`browser.frameLocator('#payment').getByLabel('Card number')`); keeps
  `locator(css)` and `frameLocator(css)` for nesting. The agent's tree
  leaves out a frame from another site, so script steps there with it.
- `evaluate(fn | source, arg?)`: runs a function or source string in the
  page, JSON in and out, no closures; a throw in the page is
  `EVALUATE_FAILED`.
- `addInitScript(source | { path } | fn)`, `addInitScript(fn, arg)`: runs
  before the page's own scripts; call it before `app.open`. `arg` is JSON.
- `route(pattern, handler)`, `unroute(pattern)`: intercept requests, newest
  route first; `pattern` is a URL pattern or `{ method, url }` for one method.
  `route.request` has `url`, `method`, `headers`, `postData`.
  `route.fetch()` reads upstream without deciding the route and returns
  `{ url, status, headers, body(), text(), json() }`; redirects are not followed.
  Hand binary bodies on with `body()`, never `text()`.
  The handler calls exactly one of
  `fulfill({ status?, headers?, contentType?, json | body | path })` (`body`
  a string or bytes; several cookies as one `\n`-joined `set-cookie`),
  `continue({ url?, method?, headers?, postData? })` (straight to the
  network; a header set to `undefined` is dropped, the configured `headers`
  still added on an allowed origin), `fallback()` (the route registered
  before it), or `abort()`;
  none or two fails the next step with `ACTION_FAILED`, an unsupported
  option with `INVALID_ARGUMENT`.
- `unrouteAll()` removes every route; configured headers stay.
- `waitForResponse(pattern, { timeout? })`: resolves once the headers
  arrive, with `{ url, status, headers, body(), json(), text() }`; the body
  readers wait for the body (up to the action timeout) and reject with
  `ACTION_FAILED` when it could not be read. Start the wait before the
  request, including the first `browser.goto` or `app.open`.
- `cookies()`, `setCookies([...])`: a target is an http(s) URL or a domain.
- `clearCookies({ name?, domain?, path? })`: remove cookies matching every
  string or RegExp filter; no options removes all cookies, other storage stays.
- `setViewport({ width, height })`: resize.
- `emulateMedia({ colorScheme?, reducedMotion? })`: what the page's `@media`
  rules and `matchMedia` read, for the rest of the test. Call it before
  `app.open` to load the page with it; a feature left out keeps its value.
- `onDialog('accept' | 'dismiss' | handler)`: awaited; resolves to an async
  unsubscribe. Register it before the tap that opens the dialog. A handler
  gets `{ type, message, accept(text?), dismiss() }`, where `type` is
  `alert`, `confirm`, `prompt`, or `beforeunload`, `accept` taking the prompt
  text; no handler, or one that neither accepts nor dismisses, fails the
  next step with `INVALID_STATE`. A throwing handler's unanswered dialog is
  dismissed too, and its error fails the next step.
- `waitForDownload(() => trigger, { timeout? })`: returns
  `{ path, absolutePath, suggestedFilename }`; `absolutePath` names the saved
  runner-side file for reading its contents, including with a hosted browser.
- `waitForDownloads(() => trigger, { count, timeout? })`: calls the trigger
  once and returns `count` of those results in start order.
- `keyboard.press(key)`, `keyboard.type(text)`, `keyboard.down(key)`,
  `keyboard.up(key)`, `mouse.*`: unfocused input. Only `down(key)` holds a
  key or modifier until `up(key)`. `press(key)` presses and releases within
  the call. Prefer `locator.press` and `locator.fill`.
- `webmcp.tools()`, `webmcp.callTool(name, input?)`: the tools the page
  registers through WebMCP (`document.modelContext`), listed and called
  with no model. Needs `web({ webmcp: true })`, Chromium or Firefox, and a page on
  `https:` or `localhost`; on a page without WebMCP both fail with
  `UNSUPPORTED_CAPABILITY`. `callTool` returns the tool's result and fails
  with `ACTION_FAILED` when the page has no such tool, the tool throws, or
  the tool navigates the page or runs out of time before it answers (it may
  have run).
  Both cover the page's main frame only, not its iframes.

A `route`, `unroute`, or `waitForResponse` pattern is a glob string or
`RegExp` matched against the full URL (`*` stays within one path segment,
`**` crosses `/`, `?` is one character), or `{ method, url }` to match one
HTTP method too, case-insensitively. A method matches exactly that method:
`GET` does not answer `HEAD`. `unroute` removes routes
registered with the same pattern, method included, rather than URL-matching
them. A predicate function is `INVALID_ARGUMENT`.

## Habits

- Selectors are the names a user sees (roles, labels, text), read from the
  live screen over MCP or from the source; add an `aria-label` or heading
  where the app has no accessible name rather than fall back to
  `browser.locator('.btn-primary')`. A `data-testid` in the source is not a
  reason to use `getByTestId`: it stays the last resort.
- Test data gets a run-unique name (`randomUUID()`, or `unique(\`Invoice ${randomUUID()}\`)`
  when a goal's `params` carry it) and is deleted by the fixture that created it,
  so replays and retries never trip over leftovers ("Each test owns its
  starting state" above).
- APIs live in the same suite: `request.get('/api/users')` (each call a
  step, a path against the app URL) and the value matchers on
  `response.status` and `await response.json()`. `request` sends no browser cookies: pass the app's
  session cookie from `browser.cookies()` in a `cookie` header when the API
  needs the session.
- No sleeps, fixed delays, or polling loops. Wait for the state, not a
  duration: `agent.waitFor('the import finished')` with a `timeout` long
  enough for the slowest case (topic `agent` lists its model and budget
  limits), or a matcher with a longer `timeout` when a locator names the
  state exactly.
- `await` every step call, `expect.poll`, and `toPass`, else `STEP_NOT_AWAITED` at the line of the call.
- Assert the fact a model produced with `toContain`, not its exact sentence.
