import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harmonyEnvironment } from '../scripts/harmony-environment.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'yuqu-toolchain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'local.json');
  const options = { env: { ProgramFiles: root }, platform: 'win32', configPath };
  return { root, configPath, options };
}

test('explicit Studio retains its bundled JVM and wins over CLI/local settings', t => {
  const { root, options, configPath } = setup(t);
  writeFileSync(configPath, 'malformed local config must not override explicit environment');
  const env = { ...options.env, DEVECO_STUDIO_HOME: join(root, 'studio'),
    DEVECO_COMMAND_LINE_TOOLS_HOME: join(root, 'cli'), JAVA_HOME: join(root, 'other-java') };
  const result = harmonyEnvironment({ ...options, env });
  assert.equal(result.kind, 'studio');
  assert.equal(result.node, join(env.DEVECO_STUDIO_HOME, 'tools/node/node.exe'));
  assert.equal(result.javaHome, join(env.DEVECO_STUDIO_HOME, 'jbr'));
  assert.equal(result.sdk, join(env.DEVECO_STUDIO_HOME, 'sdk'));
});

test('portable CLI configuration resolves bundled tools without changing process environment', t => {
  const { root, options, configPath } = setup(t);
  const commandLineToolsHome = join(root, 'cli'), javaHome = join(root, 'java');
  writeFileSync(configPath, JSON.stringify({ commandLineToolsHome, javaHome }));
  mkdirSync(join(commandLineToolsHome, 'sdk/default'), { recursive: true });
  writeFileSync(join(commandLineToolsHome, 'sdk/default/sdk-pkg.json'), JSON.stringify({ data: { version: '26.0.0.105' } }));
  const before = { ...options.env };
  const result = harmonyEnvironment(options);
  assert.equal(result.node, join(commandLineToolsHome, 'tool/node/node.exe'));
  assert.equal(result.hvigor, join(commandLineToolsHome, 'hvigor/bin/hvigorw.js'));
  assert.equal(result.ohpm, join(commandLineToolsHome, 'ohpm/bin/pm-cli.js'));
  assert.equal(result.java, join(javaHome, 'bin/java.exe'));
  assert.equal(result.sdkInfo.version, '26.0.0.105');
  assert.deepEqual(options.env, before);
});

test('explicit CLI never silently falls back to another installation and reports missing JVM', t => {
  const { root, options, configPath } = setup(t);
  writeFileSync(configPath, JSON.stringify({ commandLineToolsHome: join(root, 'local-cli'), javaHome: join(root, 'local-java') }));
  const env = { ...options.env, DEVECO_COMMAND_LINE_TOOLS_HOME: join(root, 'explicit-cli') };
  const result = harmonyEnvironment({ ...options, env });
  assert.equal(result.root, env.DEVECO_COMMAND_LINE_TOOLS_HOME);
  assert.equal(result.java, undefined);
  const override = harmonyEnvironment({ ...options, env: { ...env, JAVA_HOME: join(root, 'jdk'), DEVECO_SDK_HOME: join(root, 'sdk') } });
  assert.equal(override.javaHome, join(root, 'jdk'));
  assert.equal(override.sdk, join(root, 'sdk'));
});

test('missing installations and malformed portable paths fail clearly', t => {
  const { options, configPath } = setup(t);
  assert.equal(harmonyEnvironment(options), undefined);
  for (const value of [null, [], {}, { commandLineToolsHome: './cli' }, { commandLineToolsHome: join(tmpdir(), 'cli'), javaHome: 21 }]) {
    writeFileSync(configPath, JSON.stringify(value));
    assert.throws(() => harmonyEnvironment(options), /绝对路径/);
  }
});
