---
'@e2e-dev/core': patch
'e2e': patch
---

The key grammar has TV remote keys, listed in `REMOTE_KEY_NAMES`: `up`, `down`, `left`, `right`, `select`, `back`, `menu`, `home`, `play`, `pause`, `play-pause`, `stop`, `rewind`, `fast-forward`, `next`, and `previous`. They are lowercase, so `home` is the remote's Home button and `Home` stays the keyboard key. `isRemoteKey` tells one apart; `parseKey` and `ParsedKey` still cover the keyboard keys only.

An engine opts in with `remoteKeys: true`, which requires `keyboard` and is carried in the engine protocol's manifest. A remote key reaches the engine through `keyboard.press` alone: `locator.press('menu')` waits for its node and then presses the remote. On any other engine the harness refuses a remote key with `UNSUPPORTED_CAPABILITY` before it reaches the engine, naming the keyboard key of the same word when there is one. An executor's `press` and `pressKey` take the remote keys, both recorded as `pressKey` so a replay waits on no node, and custom executors see the capability as `ctx.target.remoteKeys`. An executor that lets an `UNSUPPORTED_CAPABILITY` from `pressKey` escape `runStep` fails `agent.act` with `POLICY_DENIED`, the original error as its `cause`, so catch it there to fall back. On a target whose engine declares `remoteKeys`, the built-in agent's `press` tool names the remote keys.
