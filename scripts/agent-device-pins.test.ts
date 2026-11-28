import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentDevicePins, type EngineReleases } from './agent-device-pins.ts';
import type { PackageManifest } from './public-packages.ts';

const engine: PackageManifest = { name: '@e2e-dev/mobile', version: '0.12.9', dependencies: { 'agent-device': '0.21.44' } };

/** Engine releases as tags would give them: each released version and the agent-device it pinned. */
function releases(history: Record<string, string>): EngineReleases {
  return {
    release: (version) => (version in history ? { tagged: true, agentDevice: history[version] } : { tagged: false }),
    releasedWith: (pin) => Object.keys(history).filter((version) => history[version] === pin),
  };
}

/** Tags up to 0.12.9, which pinned 0.21.42; the pin 0.21.44 is not released yet, so it ships in 0.12.10. */
const history = releases({ '0.12.8': '0.21.39', '0.12.9': '0.21.42' });

/** A provider package pinning `driver` at `version`, peering on the engine at `floor`. */
function provider(name: string, driver: string, version: string, floor: string | undefined): PackageManifest {
  return {
    name,
    dependencies: { [driver]: version },
    ...(floor === undefined ? {} : { peerDependencies: { '@e2e-dev/mobile': `>=${floor} <1` } }),
  };
}

describe('agentDevicePins', () => {
  it('passes when every driver package pins the engine version and peers on the release that ships it', () => {
    const result = agentDevicePins([
      engine,
      provider('@e2e-dev/testmu', '@agent-device/testmu', '0.21.44', '0.12.10'),
      provider('@e2e-dev/e2b', 'agent-device', '0.21.44', '0.12.10'),
      { name: '@e2e-dev/eas', peerDependencies: { '@e2e-dev/mobile': '>=0.12.9 <1' } },
    ], history);
    assert.deepEqual(result.problems, []);
    assert.equal(result.version, '0.21.44');
    assert.deepEqual(result.pinned, ['@e2e-dev/e2b', '@e2e-dev/mobile', '@e2e-dev/testmu']);
  });

  it('accepts a floor on a tagged release that ships the pin', () => {
    const released = releases({ '0.12.9': '0.21.42', '0.12.10': '0.21.44' });
    const { problems } = agentDevicePins([{ ...engine, version: '0.12.10' }, provider('@e2e-dev/limrun', 'agent-device', '0.21.44', '0.12.10')], released);
    assert.deepEqual(problems, []);
  });

  it('flags a package a bump missed, by name and both versions', () => {
    const { problems } = agentDevicePins([engine, provider('@e2e-dev/revyl', '@agent-device/revyl', '0.21.43', '0.12.10')], history);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /@e2e-dev\/revyl depends on @agent-device\/revyl "0\.21\.43"; @e2e-dev\/mobile pins agent-device "0\.21\.44"/);
  });

  it('flags a bump that moved every pin and no floor', () => {
    // 0.12.10 is released with 0.21.44; every pin moved to 0.21.45, every floor stayed.
    const released = releases({ '0.12.9': '0.21.42', '0.12.10': '0.21.44' });
    const bumped = { ...engine, version: '0.12.10', dependencies: { 'agent-device': '0.21.45' } };
    const { problems } = agentDevicePins([
      bumped,
      provider('@e2e-dev/limrun', 'agent-device', '0.21.45', '0.12.10'),
      provider('@e2e-dev/testmu', '@agent-device/testmu', '0.21.45', '0.12.10'),
    ], released);
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /@e2e-dev\/mobile 0\.12\.10 pins agent-device "0\.21\.44", not "0\.21\.45": raise it to >=0\.12\.11/);
  });

  it('points a floor on an older release at the first release that ships the pin, as #2304 needed', () => {
    // Every pin moved 0.21.42 -> 0.21.43 while 0.12.9 (the newest tag) still ships 0.21.42.
    const moved = { ...engine, dependencies: { 'agent-device': '0.21.43' } };
    const { problems } = agentDevicePins([
      moved,
      provider('@e2e-dev/revyl', '@agent-device/revyl', '0.21.43', '0.12.9'),
      provider('@e2e-dev/e2b', 'agent-device', '0.21.43', '0.12.6'),
    ], history);
    assert.equal(problems.length, 2);
    for (const problem of problems) assert.match(problem, /raise it to >=0\.12\.10/);
  });

  it('flags a floor naming a release that was never tagged and is not the next one', () => {
    const { problems } = agentDevicePins([engine, provider('@e2e-dev/limrun', 'agent-device', '0.21.44', '0.12.7')], history);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /no @e2e-dev\/mobile 0\.12\.7 release is tagged/);
  });

  it('reports only the mis-pinned package, not its floor', () => {
    const { problems } = agentDevicePins([
      engine,
      provider('@e2e-dev/limrun', 'agent-device', '0.21.44', '0.12.10'),
      provider('@e2e-dev/revyl', '@agent-device/revyl', '0.21.45', '0.12.6'),
    ], history);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /@e2e-dev\/revyl depends on @agent-device\/revyl "0\.21\.45"/);
  });

  it('holds an optional dependency on agent-device to the pin, over a regular one of the same name', () => {
    const { problems, pinned } = agentDevicePins([
      engine,
      {
        name: '@e2e-dev/cloud',
        dependencies: { '@agent-device/cloud': '0.21.44' },
        optionalDependencies: { '@agent-device/cloud': '0.21.40' },
        peerDependencies: { '@e2e-dev/mobile': '>=0.12.10 <1' },
      },
    ], history);
    assert.deepEqual(pinned, ['@e2e-dev/cloud', '@e2e-dev/mobile']);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /@e2e-dev\/cloud depends on @agent-device\/cloud "0\.21\.40"/);
  });

  it('flags a driver package with no engine peer', () => {
    const { problems } = agentDevicePins([engine, provider('@e2e-dev/limrun', 'agent-device', '0.21.44', undefined)], history);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /has no @e2e-dev\/mobile peer/);
  });

  it('checks pins but notes the floors it could not check in a checkout without tags', () => {
    const { problems, notes } = agentDevicePins([engine, provider('@e2e-dev/e2b', 'agent-device', '0.21.44', '0.12.6')], undefined);
    assert.deepEqual(problems, []);
    assert.equal(notes.length, 1);
  });

  it('reports a missing engine pin instead of passing', () => {
    const { problems } = agentDevicePins([{ name: '@e2e-dev/mobile' }], history);
    assert.equal(problems.length, 1);
  });

  it('ignores packages that do not drive agent-device', () => {
    const { problems, pinned } = agentDevicePins([engine, { name: '@e2e-dev/web', dependencies: { 'playwright-core': '1.65.1' } }], history);
    assert.deepEqual(problems, []);
    assert.deepEqual(pinned, ['@e2e-dev/mobile']);
  });
});
