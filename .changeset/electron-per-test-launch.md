---
'@e2e-dev/electron': patch
---

The `electron` fixture covers what a real app's suite needs beside `screen`:

- `electron.launch({ launchArguments, env, cwd })` launches the app with arguments, environment variables, and a working directory of one test (`electron({ cwd })` sets the directory for every test), and `electron.userDataDir` is there before the launch, so a test can put data in it first. [Per-test arguments](https://e2e.com/docs/electron#launch-with-per-test-arguments)
- `electron.keyboard` and `electron.mouse` send input to the active window, wherever its focus is: `await electron.keyboard.press('Escape')`. [Keyboard and mouse](https://e2e.com/docs/electron#keyboard-and-mouse)
- `electron.activeWindow()` returns the window `screen` reads, and a window has `evaluate(fn, arg)`, which runs in its page, and `reload()`. [Run code in a window](https://e2e.com/docs/electron#run-code-in-a-window)

Fixes:

- A button drawn as an icon font's glyph and text, such as `<button><i class="fa fa-search"></i> Scan</button>`, is named `Scan`, as on the web. The glyph was part of its name, so `getByRole('button', 'Scan')` found nothing.
- `getByText` on text in a container such as a toolbar, inside elements the accessibility tree leaves out, taps the text. It tapped the middle of the container, which could miss the element that handles the click.
- A step that starts while the active window closes, such as a sign-in popup that closes itself, reads the window active after it instead of failing with `APP_NOT_OPEN`.
- `locator.focus()` succeeds when the element hands focus to a part of itself, as a grid row does to its editor. It failed with `ACTION_FAILED`.
