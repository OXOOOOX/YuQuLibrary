import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readJson(path) {
  if (!path || !existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function harmonyEnvironment({ env = process.env, platform = process.platform,
  configPath = fileURLToPath(new URL('../.local/tooling/harmony-toolchain.json', import.meta.url)) } = {}) {
  const windows = platform === 'win32';
  let root = env.DEVECO_STUDIO_HOME || env.DEVECO_COMMAND_LINE_TOOLS_HOME;
  let kind = env.DEVECO_STUDIO_HOME ? 'studio' : 'command-line';
  let config;
  if (!root) {
    config = readJson(configPath);
    if (config !== undefined) {
      if (!config || typeof config !== 'object' || Array.isArray(config) ||
        typeof config.commandLineToolsHome !== 'string' || !isAbsolute(config.commandLineToolsHome) ||
        (config.javaHome !== undefined && (typeof config.javaHome !== 'string' || !isAbsolute(config.javaHome)))) {
        throw new Error(`鸿蒙本地工具配置需要绝对路径 commandLineToolsHome、可选 javaHome：${configPath}`);
      }
      root = config.commandLineToolsHome;
    } else {
      const candidates = [windows ? join(env.ProgramFiles ?? 'C:\\Program Files', 'huawei', 'DevEco Studio') : undefined,
        platform === 'darwin' ? '/Applications/DevEco-Studio.app/Contents' : undefined].filter(Boolean);
      root = candidates.find(path => existsSync(join(path, 'product-info.json')));
      kind = 'studio';
    }
  }
  if (!root) return undefined;
  const studio = kind === 'studio';
  const tools = studio ? join(root, 'tools') : root;
  const nodeHome = join(root, studio ? 'tools' : 'tool', 'node');
  // A command-line distribution has no JDK. Keep its explicitly selected JVM scoped to child processes.
  const javaHome = studio ? join(root, 'jbr') : (env.JAVA_HOME || config?.javaHome);
  const sdk = env.DEVECO_SDK_HOME || join(root, 'sdk');
  return {
    root, kind, sdk, nodeHome, javaHome,
    node: join(nodeHome, windows ? 'node.exe' : 'bin/node'),
    java: javaHome ? join(javaHome, 'bin', windows ? 'java.exe' : 'java') : undefined,
    ohpm: join(tools, 'ohpm', 'bin', 'pm-cli.js'),
    hvigor: join(tools, 'hvigor', 'bin', 'hvigorw.js'),
    hdc: join(sdk, 'default', 'openharmony', 'toolchains', windows ? 'hdc.exe' : 'hdc'),
    emulator: join(tools, 'emulator', windows ? 'Emulator.exe' : 'Emulator'),
    studioVersion: studio ? readJson(join(root, 'product-info.json'))?.version : undefined,
    sdkInfo: readJson(join(sdk, 'default', 'sdk-pkg.json'))?.data,
    ohpmVersion: readJson(join(tools, 'ohpm', 'package.json'))?.version,
    hvigorVersion: readJson(join(tools, 'hvigor', 'hvigor', 'package.json'))?.version,
    emulatorInfo: readJson(join(tools, 'emulator', 'sdk-pkg.json'))?.data,
  };
}
