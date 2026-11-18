import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { harmonyEnvironment } from './harmony-environment.mjs';

const environment = harmonyEnvironment();
if (!environment) {
  console.log('未发现鸿蒙工具链；可设置 DEVECO_STUDIO_HOME 或 DEVECO_COMMAND_LINE_TOOLS_HOME（另需 JAVA_HOME）。');
  process.exitCode = 1;
} else {
  console.log(`DevEco ${environment.kind === 'studio' ? 'Studio ' + environment.studioVersion : 'Command Line Tools'} — ${environment.root}`);
  console.log(`SDK: ${environment.sdkInfo?.displayName ?? '未发现'} / ${environment.sdkInfo?.version ?? '?'} / ${environment.sdkInfo?.releaseType ?? '?'} — ${environment.sdk}`);
  for (const [name, path] of Object.entries({ node: environment.node, java: environment.java,
    ohpm: environment.ohpm, hvigor: environment.hvigor, hdc: environment.hdc })) {
    const present = path && existsSync(path);
    console.log(`${name}: ${present ? path : '缺失：' + (path ?? '请配置 JDK 21 的 JAVA_HOME 或本地 javaHome')}`);
    if (!present) process.exitCode = 1;
  }
  console.log(`emulator（设备验证可选）: ${existsSync(environment.emulator) ? environment.emulator : '未安装'}`);
  if (!environment.sdkInfo) process.exitCode = 1;
  console.log(`ohpm ${environment.ohpmVersion} / Hvigor ${environment.hvigorVersion} / Emulator ${environment.emulatorInfo?.version} ${environment.emulatorInfo?.releaseType}`);
  if (process.argv.includes('--devices') && existsSync(environment.hdc)) {
    const result = spawnSync(environment.hdc, ['list', 'targets'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const targets = (result.stdout ?? '').trim().split(/\r?\n/).filter(line => line && !line.includes('Empty') && !line.startsWith('['));
    console.log(`设备枚举: ${result.status === 0 ? targets.length + ' 个目标（不输出序列号）' : '枚举未成功'}`);
    if (result.status !== 0) process.exitCode = 1;
  }
}
console.log('仅检查工具文件与版本；不表示编译或模拟器运行通过，不修改全局环境、签名或系统功能。');
