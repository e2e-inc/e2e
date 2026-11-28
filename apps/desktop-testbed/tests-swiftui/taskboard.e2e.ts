import { test } from '@e2e-dev/desktop';
import { expect } from 'e2e';

/**
 * TaskBoard, a SwiftUI app, driven in the background. No test pins a window
 * before it needs a second one: on macOS 27 a press inside a sheet adds a
 * system dialog window to the app, which must never become the screen.
 */
test.describe('TaskBoard (SwiftUI)', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('navigates the sidebar and reads per-project lists', async ({ screen }) => {
    await expect(screen.getByTestId('count')).toHaveText('2 shown');
    await screen.getByRole('tree', 'Sidebar').selectOption('Work, 2');
    await expect(screen.getByRole('checkbox', 'Write release notes')).toBeVisible();
    await expect(screen.getByTestId('count')).toHaveText('2 shown');
    await screen.getByRole('tree', 'Sidebar').selectOption('Home, 1');
    await expect(screen.getByRole('checkbox', 'Water the plants')).toBeVisible();
    await expect(screen.getByRole('checkbox', 'Buy milk')).toBeHidden();
  });

  test('adds a task through a sheet with every kind of control', async ({ screen }) => {
    await screen.getByRole('button', 'New Task').tap();
    const save = screen.getByRole('button', 'Save');
    await expect(save).toBeDisabled();
    await screen.getByTestId('new-title').fill('Ship the desktop engine');
    await expect(save).toBeEnabled();
    await screen.getByRole('radio', 'High').tap();
    await screen.getByTestId('new-estimate').fill('3');
    await screen.getByTestId('new-flagged').check();
    await screen.getByTestId('new-notes').fill('line one\nline two');
    await save.tap();
    await expect(screen.getByTestId('status')).toHaveText('Added Ship the desktop engine (flagged)');
    await expect(screen.getByTestId('count')).toHaveText('3 shown');
    await expect(screen.getByRole('checkbox', 'Ship the desktop engine')).toBeVisible();
  });

  test('checks a toggle and steps a stepper as the first action in a fresh sheet', async ({ screen }) => {
    // The first press inside a SwiftUI sheet answers with an error although it lands: judged by the state it led to.
    await screen.getByRole('button', 'New Task').tap();
    const flagged = screen.getByTestId('new-flagged');
    await flagged.check();
    await expect(flagged).toBeChecked();
    await screen.getByRole('button', 'Cancel').tap();
    await screen.getByRole('button', 'New Task').tap();
    await screen.getByTestId('new-estimate').fill('5');
    await expect(screen.getByTestId('new-estimate')).toHaveValue('5');
  });

  test('refuses a stepper value it cannot take, and leaves the value as it was', async ({ screen }) => {
    await screen.getByRole('button', 'New Task').tap();
    const estimate = screen.getByTestId('new-estimate');
    await estimate.fill('3');
    // 2.5 steps past the value and back. 40 is outside the stepper's range: refused before any step.
    const refusals = [
      ['2.5', 'goes past the value'],
      ['40', 'outside the range'],
    ] as const;
    for (const [value, reason] of refusals) {
      const error = await estimate.fill(value, { timeout: 5_000 }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error, value).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining(reason) });
      await expect(estimate).toHaveValue('3');
    }
  });

  test('cancels the sheet with Escape and submits it with Enter', async ({ screen }) => {
    await screen.getByRole('button', 'New Task').tap();
    await screen.getByTestId('new-title').fill('Throwaway');
    await screen.getByTestId('new-title').press('Escape');
    await expect(screen.getByRole('button', 'Save')).toBeHidden();
    await expect(screen.getByTestId('count')).toHaveText('2 shown');
    await screen.getByRole('button', 'New Task').tap();
    await screen.getByTestId('new-title').pressSequentially('Typed by keys');
    await screen.getByTestId('new-title').press('Enter');
    await expect(screen.getByTestId('status')).toHaveText('Added Typed by keys');
  });

  test('keeps reading the app window a while after a press inside a sheet', async ({ screen }) => {
    // On macOS 27 a system dialog window joins the app a few seconds after such a press; the screen stays the app's.
    await screen.getByRole('button', 'New Task').tap();
    await screen.getByTestId('new-flagged').check();
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await screen.getByTestId('new-title').fill('Still here');
    await screen.getByRole('button', 'Save').tap();
    await expect(screen.getByTestId('status')).toHaveText('Added Still here (flagged)');
  });

  test('completes a task and deletes one through an alert', async ({ screen }) => {
    const milk = screen.getByRole('checkbox', 'Buy milk');
    await milk.check();
    await expect(milk).toBeChecked();
    await screen.getByRole('button', 'Delete Call the bank').tap();
    await expect(screen.getByText('Delete task?')).toBeVisible();
    await screen.getByRole('button', 'Cancel').tap();
    await expect(screen.getByRole('checkbox', 'Call the bank')).toBeVisible();
    await screen.getByRole('button', 'Delete Call the bank').tap();
    await screen.getByRole('button', 'Delete').tap();
    await expect(screen.getByTestId('status')).toHaveText('Deleted Call the bank');
    await expect(screen.getByRole('checkbox', 'Call the bank')).toBeHidden();
  });

  test('waits out an async sync', async ({ screen }) => {
    await screen.getByRole('button', 'Sync').tap();
    await expect(screen.getByTestId('status')).toHaveText('Syncing…');
    await expect(screen.getByRole('button', 'Sync')).toBeDisabled();
    await expect(screen.getByTestId('status')).toHaveText('Synced 5 open tasks');
    await expect(screen.getByRole('button', 'Sync')).toBeEnabled();
  });

  test('filters with the toolbar search field', async ({ screen }) => {
    // At the window's first size the toolbar has no room for the field, and it collapses into a button that opens it.
    await screen.getByRole('button', 'Search').tap();
    await screen.getByRole('textbox', 'Search tasks').fill('bank');
    await expect(screen.getByTestId('count')).toHaveText('1 shown');
    await expect(screen.getByRole('checkbox', 'Buy milk')).toBeHidden();
    await screen.getByRole('textbox', 'Search tasks').clear();
    await expect(screen.getByTestId('count')).toHaveText('2 shown');
  });

  test('chooses from a toolbar menu button', async ({ screen }) => {
    await screen.getByRole('button', 'Sort').tap();
    await screen.getByRole('menuitem', 'By Priority').tap();
    await expect(screen.getByTestId('status')).toHaveText('Sorted by priority');
  });

  test('opens a popover and reads its content as visible', async ({ screen }) => {
    await screen.getByRole('button', 'Info').tap();
    const info = screen.getByTestId('info-text');
    await expect(info).toBeVisible();
    await expect(info).toHaveText('TaskBoard 1.0, a desktop engine sample');
  });

  test('scrolls a lazy 200-row list to its end, past a sidebar that does not scroll', async ({ screen }) => {
    await screen.getByRole('tree', 'Sidebar').selectOption('Archive, 0');
    await expect(screen.getByTestId('count')).toHaveText('200 shown');
    const last = screen.getByRole('checkbox', 'Archived task 200');
    await screen.scrollUntilVisible(last, { direction: 'down' });
    await expect(last).toBeVisible();
    await expect(last).toBeChecked();
  });

  test('reads the text of a list as the text of its rows', async ({ screen }) => {
    await expect(screen.getByTestId('tasks')).toContainText('Buy milk');
    await expect(screen.getByTestId('tasks')).toContainText('Call the bank');
  });

  test('selects a row and expands its details', async ({ screen }) => {
    await screen.getByRole('treeitem').filter({ hasText: 'Buy milk' }).tap();
    const details = screen.getByRole('button', 'Details');
    await expect(details).toBeVisible();
    await details.tap();
    await expect(details).toBeExpanded();
    await expect(screen.getByTestId('detail-estimate')).toHaveText('Estimate: 1 h');
  });

  test('drives a second window with tabs, and sees its effect in the first', async ({ screen, desktop }) => {
    await screen.getByRole('checkbox', 'Buy milk').check();
    const preferences = await desktop.waitForWindow(() => screen.getByRole('button', 'Preferences').tap());
    expect(await preferences.title()).toBe('Preferences');
    await screen.getByRole('checkbox', 'Show completed').uncheck();
    await screen.getByRole('combobox', 'Theme').selectOption('Dark');
    await expect(screen.getByRole('combobox', 'Theme')).toHaveValue('Dark');
    await screen.getByRole('slider', 'Font size').fill('18');
    await expect(screen.getByTestId('font-size')).toHaveText('Font size 18');
    await screen.getByRole('tab', 'Advanced').tap();
    await screen.getByTestId('server').fill('https://staging.test');
    await expect(screen.getByTestId('server-echo')).toHaveText('Server is https://staging.test');
    await (await desktop.window({ title: 'Inbox' })).activate();
    await expect(screen.getByTestId('count')).toHaveText('1 shown');
    await expect(screen.getByRole('checkbox', 'Buy milk')).toBeHidden();
  });

  test('sends keys to a window with no control that takes keyboard focus', async ({ screen, desktop }) => {
    const keypad = await desktop.waitForWindow(() => screen.getByRole('button', 'Keypad').tap());
    expect(await keypad.title()).toBe('Keypad');
    const display = screen.getByTestId('keypad-display');
    await expect(display).toHaveText('Empty');
    await desktop.keyboard.press('4');
    await desktop.keyboard.press('2');
    await expect(display).toHaveText('42');
    await desktop.keyboard.press('Backspace');
    await expect(display).toHaveText('4');
  });

  test('opens a row context menu and chooses an item', async ({ screen }) => {
    await screen.getByRole('checkbox', 'Buy milk').secondaryTap();
    await screen.getByRole('menuitem', 'Duplicate').tap();
    await expect(screen.getByTestId('status')).toHaveText('Duplicated Buy milk');
  });

  test('taps a row by its text', async ({ screen }) => {
    await screen.getByRole('tree', 'Sidebar').selectOption('Work, 2');
    // The text is not a control; the row around it is, and takes the tap.
    await screen.getByText('Inbox, 2').tap();
    await expect(screen.getByTestId('count')).toHaveText('2 shown');
    await expect(screen.getByRole('checkbox', 'Buy milk')).toBeVisible();
  });
});
