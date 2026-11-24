# ArkUI counter on a local HarmonyOS phone

This prototype runs a deterministic test through the mobile engine against an installed ArkUI app. The test uses the public app, screen, and expect APIs. It requires a connected, unlocked phone, DevEco's hdc on PATH, and the repository's Node and pnpm toolchain.

## Prepare the phone

Use a HarmonyOS stage-model phone project with bundle name `com.example.e2ecounter`. For example, scaffold one outside this repository with DevEco CLI:

```sh
devecocli create --app-name E2ECounter --bundle-name com.example.e2ecounter --api-level 26
```

Replace its `entry/src/main/ets/pages/Index.ets` with [Index.ets](./Index.ets), then sign and run it on the phone with DevEco Studio. Check that `hdc list targets` lists the phone. Use a single connected phone for the test below.

## Run from the fork

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @e2e-dev/core run build
pnpm --filter e2e run build
pnpm --filter @e2e-dev/mobile run build
cd packages/mobile/examples/harmonyos
node ../../../e2e/dist/cli/bin.js doctor
node ../../../e2e/dist/cli/bin.js run
```

[The test](./tests/counter.e2e.ts) launches the app, expects “计数：0”, taps the “加一” button, and expects “计数：1”. It needs no model or credentials. The runner writes its report to `.e2e/report.json` in the example directory.

## Verification

On November 24, 2026, [commit 7107dd86](https://github.com/fryandev/e2e/commit/7107dd8672cc6cc1dc325ac28b947ce827f80d89) passed the counter test on a physical Huawei Mate 70 Air running HarmonyOS 7 (API 26) with agent-device 0.21.42. The runner recorded four passing steps in 4.74 seconds: app launch, the initial text assertion, a button tap and the updated text assertion.

On this setup, `e2e doctor` detected one connected phone and HDC 3.2.0f. A locked phone can still pass these checks. If launching the app reports that the screen is locked, unlock the phone and rerun the test.
