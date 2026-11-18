import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { harmonyEnvironment } from './harmony-environment.mjs';

const environment = harmonyEnvironment();
if (!environment) throw new Error('未发现鸿蒙工具链，请配置 DEVECO_STUDIO_HOME 或 DEVECO_COMMAND_LINE_TOOLS_HOME。');
for (const path of [environment.node, environment.java, environment.ohpm, environment.hvigor]) {
  if (!path || !existsSync(path)) throw new Error(`工具不完整：${path ?? '请配置 JDK 21 的 JAVA_HOME 或本地 javaHome'}`);
}
if (!environment.sdkInfo) throw new Error('未发现配套 SDK，请检查 DEVECO_SDK_HOME。');
const cwd = fileURLToPath(new URL('../apps/harmony/', import.meta.url));
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
const env = {
  ...process.env,
  JAVA_HOME: environment.javaHome,
  NODE_HOME: environment.nodeHome,
  DEVECO_NODE_HOME: environment.nodeHome,
  DEVECO_SDK_HOME: environment.sdk,
  [pathKey]: [environment.nodeHome, join(environment.javaHome, 'bin'), process.env[pathKey] ?? ''].join(delimiter),
};
async function run(script, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(environment.node, [script, ...args], { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`鸿蒙工具执行失败：${signal ?? code}`)));
  });
}
console.log(`使用 DevEco ${environment.kind === 'studio' ? environment.studioVersion : 'Command Line Tools'} / SDK ${environment.sdkInfo.version} ${environment.sdkInfo.releaseType}`);
await import('./generate-audio-fixture.mjs');
await run(environment.ohpm, ['install', '--all']);
const appPackage = process.argv.includes('--app');
await run(environment.hvigor, ['--mode', appPackage ? 'project' : 'module', '-p', 'product=default',
  ...(!appPackage ? ['-p', 'module=entry@default'] : []),
  '-p', `buildMode=${appPackage ? 'release' : 'debug'}`, ...(process.argv.includes('--clean') ? ['clean'] : []),
  appPackage ? 'assembleApp' : 'assembleHap', '--no-daemon']);
console.log(appPackage ? 'Release APP 构建完成；尚需 DevEco Upload Product / Testing Only 云签名及平台检测，未上传或发布。' :
  '构建完成。签名、设备安装与运行结果仍需单独验证。');
