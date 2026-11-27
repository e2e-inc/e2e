import { test } from '@e2e-dev/desktop';
import { readFileSync } from 'node:fs';
import { Transformer } from '@napi-rs/image';
import { credentials, expect } from 'e2e';

/** What `desktop.menu` refused a path with, or `chosen`. */
const refusalOf =
  (desktop: { menu(...path: [string, ...string[]]): Promise<void> }) =>
  (path: [string, ...string[]]): Promise<string> =>
    desktop.menu(...path).then(
      () => 'chosen',
      (cause: unknown) => String(cause),
    );

test.describe('sign-in form', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('signs in with every control set', async ({ screen }) => {
    const ada = credentials.user('ada');
    await expect(screen.getByText('Not signed in')).toBeVisible();
    await screen.getByRole('textbox', 'Username').fill(ada.username);
    await screen.getByRole('textbox', 'Password').fill(ada.password);
    await screen.getByRole('checkbox', 'Remember me').check();
    await expect(screen.getByRole('checkbox', 'Remember me')).toBeChecked();
    await screen.getByRole('combobox', 'Plan').selectOption('Team');
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Team');
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as ada on Team, remembered (password: 7 characters)');
  });

  test('selects an option of a pop-up whose menu a tap already opened', async ({ screen }) => {
    const plan = screen.getByRole('combobox', 'Plan');
    await plan.tap();
    await expect(screen.getByRole('menuitem', 'Team')).toBeVisible();
    // The open menu is the list: a press to open it again would close it.
    await plan.selectOption('Team');
    await expect(plan).toHaveValue('Team');
    await expect(screen.getByRole('menuitem', 'Team')).toHaveCount(0);
  });

  test('closes a pop-up menu a tap opened when the select asks for the option it already shows', async ({ screen }) => {
    const plan = screen.getByRole('combobox', 'Plan');
    await plan.tap();
    await expect(screen.getByRole('menuitem', 'Pro')).toBeVisible();
    await plan.selectOption('Pro');
    await expect(plan).toHaveValue('Pro');
    await expect(screen.getByRole('menuitem', 'Pro')).toHaveCount(0);
  });

  test('refuses a disabled option of a pop-up as disabled, and closes its menu', async ({ screen }) => {
    const plan = screen.getByRole('combobox', 'Plan');
    const refused = await plan.selectOption('Legacy', { timeout: 1_000 }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(refused)).toMatch(/option "Legacy" is disabled/);
    await expect(plan).toHaveValue('Pro');
    await expect(screen.getByRole('menuitem', 'Legacy')).toHaveCount(0);
  });

  test('chooses the enabled one of two pop-up options of one title', async ({ screen }) => {
    // The Plan menu holds a disabled Enterprise before an enabled one.
    const plan = screen.getByRole('combobox', 'Plan');
    await plan.selectOption('Enterprise');
    await expect(plan).toHaveValue('Enterprise');
  });

  test('types a username with an uppercase letter and a password through key events', async ({ screen }) => {
    // Typing goes key by key, as a person types: a capital takes its key with Shift, and a password field takes keystrokes.
    await screen.getByRole('textbox', 'Username').pressSequentially('Ada');
    await expect(screen.getByRole('textbox', 'Username')).toHaveValue('Ada');
    await screen.getByRole('textbox', 'Password').pressSequentially('testing');
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as Ada on Pro (password: 7 characters)');
  });

  test('puts the keyboard in the password field when it is tapped', async ({ screen, desktop }) => {
    // AppKit's password field offers a confirm action too: a tap must focus it, so the keys after it go there.
    await screen.getByRole('textbox', 'Username').tap();
    await screen.getByRole('textbox', 'Password').tap();
    await expect(screen.getByRole('textbox', 'Password')).toBeFocused();
    await desktop.press('x');
    await expect(screen.getByRole('textbox', 'Username')).toHaveValue('');
    // The key reached the password field: signing in counts one character there.
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as  on Pro (password: 1 characters)');
  });

  test('presses the shortcut of a menu item the app handles itself', async ({ screen, desktop }) => {
    await screen.getByTestId('username').fill('grace');
    await desktop.press('ControlOrMeta+Shift+r');
    await expect(screen.getByTestId('status')).toHaveText('Reset from the menu');
    await expect(screen.getByTestId('username')).toHaveValue('');
  });

  test('presses the shortcut of a menu item the app has just enabled', async ({ screen, desktop }) => {
    // AppKit validates a menu for an accessibility read at most once a second, so right after the box is checked the item still reads as disabled.
    const refused = await desktop.press('ControlOrMeta+Shift+f').then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(refused)).toMatch(/the menu item "Form > Forget Me" this shortcut triggers is disabled/);
    await screen.getByTestId('remember').check();
    await desktop.press('ControlOrMeta+Shift+f');
    await expect(screen.getByTestId('status')).toHaveText('Forgot from the menu');
    await expect(screen.getByTestId('remember')).not.toBeChecked();
  });

  test('refuses a shortcut whose menu item the background disables', async ({ screen }) => {
    // Select All is the focused field's command: with the app in the background AppKit disables it, and the key would do nothing.
    const username = screen.getByTestId('username');
    await username.fill('grace');
    const refused = await username.press('ControlOrMeta+a').then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(refused)).toMatch(/the menu item "Edit > Select All" this shortcut triggers is disabled/);
    await expect(username).toHaveValue('grace');
  });

  test('chooses a menu item the app handles itself, in the background', async ({ screen, desktop }) => {
    await screen.getByTestId('username').fill('grace');
    await desktop.menu('Form', 'Reset');
    await expect(screen.getByTestId('status')).toHaveText('Reset from the menu');
  });

  test('chooses a menu item the app has just enabled, and one a menu has just gained', async ({ screen, desktop }) => {
    // AppKit validates a menu for an accessibility read at most once a second: right after the box is checked, Forget Me still reads as disabled and Remembered as not yet filled.
    const refusal = refusalOf(desktop);
    const remember = screen.getByTestId('remember');
    expect(await refusal(['Form', 'Forget Me'])).toMatch(/the menu item "Form > Forget Me" is disabled, so nothing was sent/);
    await remember.check();
    await desktop.menu('Form', 'Forget Me');
    await expect(screen.getByTestId('status')).toHaveText('Forgot from the menu');
    expect(await refusal(['Remembered', 'Clear'])).toMatch(/the menu "Remembered" has no item "Clear"; it has "Nothing Remembered"/);
    await remember.check();
    await desktop.menu('Remembered', 'Clear');
    await expect(screen.getByTestId('status')).toHaveText('Cleared from the menu');
  });

  test('refuses a menu item the background disables, a missing one, a menu, and a path past an item', async ({ screen, desktop }) => {
    const refusal = refusalOf(desktop);
    expect(await refusal(['Edit', 'Select All'])).toMatch(/the menu item "Edit > Select All" is disabled, so nothing was sent/);
    expect(await refusal(['Form', 'Restart'])).toMatch(/the menu "Form" has no item "Restart"; it has "Reset"/);
    expect(await refusal(['Form'])).toMatch(/"Form" opens a menu; name one of its items: "Reset"/);
    expect(await refusal(['Form', 'Reset', 'Now'])).toMatch(/"Form > Reset" is a menu item, not a menu, so it has no item "Now"/);
    expect(await refusal(['Form', ''])).toMatch(/a menu item is named by its titles from the menu bar down, none empty/);
    await expect(screen.getByTestId('status')).toHaveText('Not signed in');
  });

  test('reads controls by test id and refuses an empty password', async ({ screen }) => {
    await screen.getByTestId('username').fill('grace');
    await expect(screen.getByTestId('username')).toHaveValue('grace');
    await screen.getByTestId('username').clear();
    await expect(screen.getByTestId('username')).toHaveValue('');
    await screen.getByTestId('sign-in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Password is required');
  });

  test('starts every test from a fresh launch', async ({ screen, desktop }) => {
    expect(desktop.platform).toBe('macos');
    await expect(screen.getByTestId('username')).toHaveValue('');
    await expect(screen.getByRole('checkbox', 'Remember me')).not.toBeChecked();
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Pro');
    const windows = await desktop.windows();
    expect(windows.map((window) => window.title)).toEqual(['Sign In']);
  });

  test('takes a screenshot of the window with the password field painted over', async ({ app, screen }) => {
    const password = screen.getByRole('textbox', 'Password');
    await screen.getByRole('textbox', 'Username').fill('ada');
    await password.fill(credentials.user('ada').password);
    const field = await password.boundingBox();
    const beside = await screen.getByRole('textbox', 'Username').boundingBox();
    expect(field).not.toBeNull();
    expect(beside).not.toBeNull();
    const file = await app.screenshot('filled');
    // The window is 420 points wide: the capture's width over that is its scale.
    const image = decode(new Uint8Array(readFileSync(file)));
    const scale = image.width / 420;
    // The password field's own box is painted black, and the username field beside it keeps its pixels.
    expect(blackShare(image, field!, scale)).toBe(1);
    expect(blackShare(image, beside!, scale)).toBeLessThan(0.5);
  });
});

/** A decoded capture: its width and its RGBA pixels, rows top to bottom. */
interface Image {
  readonly width: number;
  readonly pixels: Uint8Array;
}

function decode(png: Uint8Array): Image {
  const transformer = new Transformer(png);
  return { width: transformer.metadataSync().width, pixels: transformer.rawPixelsSync() };
}

/** The share of opaque black pixels inside a box given in window points, a pixel in from each edge so rounding never reaches outside it. */
function blackShare(image: Image, box: { x: number; y: number; width: number; height: number }, scale: number): number {
  const left = Math.ceil(box.x * scale) + 1;
  const top = Math.ceil(box.y * scale) + 1;
  const right = Math.floor((box.x + box.width) * scale) - 1;
  const bottom = Math.floor((box.y + box.height) * scale) - 1;
  let black = 0;
  let total = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const at = (row * image.width + column) * 4;
      total += 1;
      if (image.pixels[at] === 0 && image.pixels[at + 1] === 0 && image.pixels[at + 2] === 0 && image.pixels[at + 3] === 255) black += 1;
    }
  }
  return total === 0 ? 0 : black / total;
}
