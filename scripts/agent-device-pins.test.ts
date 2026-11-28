import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentDevicePins } from './agent-device-pins.ts';
import type { PackageManifest } from './public-packages.ts';

const engine: PackageManifest = { name: '@e2e-dev/mobile', dependencies: { 'agent-device': '0.21.44' } };

/** A provider package pinning `driver` at `version`, peering on the engine at `floor`. */
function provider(name: string, driver: string, version: string, floor: string | undefined): PackageManifest {
  return {
    name,
    dependencies: { [driver]: version },
    ...(floor === undefined ? {} : { peerDependencies: { '@e2e-dev/mobile': `>=${floor} <1` } }),
  };
}

describe('agentDevicePins', () => {
  it('passes when every driver package pins the engine version and peers on the same floor', () => {
    const result = agentDevicePins([
      engine,
      provider('@e2e-dev/testmu', '@agent-device/testmu', '0.21.44', '0.12.10'),
      provider('@e2e-dev/e2b', 'agent-device', '0.21.44', '0.12.10'),
      { name: '@e2e-dev/eas', peerDependencies: { '@e2e-dev/mobile': '>=0.12.9 <1' } },
    ]);
    assert.deepEqual(result.problems, []);
    assert.equal(result.version, '0.21.44');
    assert.deepEqual(result.pinned, ['@e2e-dev/e2b', '@e2e-dev/mobile', '@e2e-dev/testmu']);
  });

  it('flags a package a bump missed, by name and both versions', () => {
    const { problems } = agentDevicePins([engine, provider('@e2e-dev/revyl', '@agent-device/revyl', '0.21.43', '0.12.10')]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /@e2e-dev\/revyl depends on @agent-device\/revyl "0\.21\.43"; @e2e-dev\/mobile pins agent-device "0\.21\.44"/);
  });

  it('flags a peer floor left below the others on the same pin', () => {
    const { problems } = agentDevicePins([
      engine,
      provider('@e2e-dev/limrun', 'agent-device', '0.21.44', '0.12.10'),
      provider('@e2e-dev/e2b', 'agent-device', '0.21.44', '0.12.6'),
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /@e2e-dev\/e2b peers on @e2e-dev\/mobile ">=0\.12\.6 <1", below @e2e-dev\/limrun's ">=0\.12\.10 <1"/);
  });

  it('flags a driver package with no engine peer', () => {
    const { problems } = agentDevicePins([engine, provider('@e2e-dev/limrun', 'agent-device', '0.21.44', undefined)]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /has no @e2e-dev\/mobile peer/);
  });

  it('reports a missing engine pin instead of passing', () => {
    const { problems } = agentDevicePins([{ name: '@e2e-dev/mobile' }]);
    assert.equal(problems.length, 1);
  });

  it('ignores packages that do not drive agent-device', () => {
    const { problems, pinned } = agentDevicePins([engine, { name: '@e2e-dev/web', dependencies: { 'playwright-core': '1.65.1' } }]);
    assert.deepEqual(problems, []);
    assert.deepEqual(pinned, ['@e2e-dev/mobile']);
  });
});
