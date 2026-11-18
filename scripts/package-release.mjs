import { copyFile, mkdir, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const yuquOutputName = 'yuqu-server';
const bridgeOutputName = 'codex-bridge';
const webImageExtensions = new Set(['.avif', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.webp']);
const excludedDirectoryNames = new Set(['.cache', '.local', '.next', 'cache', 'node_modules']);
const stableCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function usage() {
  return '用法：node scripts/package-release.mjs --output <绝对新目录> --bridge <CodexBridge绝对路径>';
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (flag !== '--output' && flag !== '--bridge') throw new Error(`未知参数：${flag}\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${flag} 缺少值\n${usage()}`);
    if (values.has(flag)) throw new Error(`参数 ${flag} 重复`);
    values.set(flag, value);
    index += 1;
  }
  const output = values.get('--output');
  const bridge = values.get('--bridge');
  if (!output || !bridge) throw new Error(`必须同时提供 --output 和 --bridge\n${usage()}`);
  if (!isAbsolute(output)) throw new Error('--output 必须是绝对路径');
  if (!isAbsolute(bridge)) throw new Error('--bridge 必须是绝对路径');
  return { output: resolve(output), bridge: resolve(bridge) };
}

function isWithin(root, candidate) {
  const rootValue = process.platform === 'win32' ? root.toLowerCase() : root;
  const candidateValue = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const remainder = relative(rootValue, candidateValue);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

async function assertPathAncestorsHaveNoLinks(target, label) {
  const chain = [];
  let current = resolve(target);
  while (true) {
    chain.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of chain) {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw new Error(`${label}包含符号链接或 reparse 点：${path}`);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function assertDirectory(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`${label}包含符号链接或 reparse 点：${path}`);
  if (!stats.isDirectory()) throw new Error(`${label}不是目录：${path}`);
}

async function assertRegularSourceFile(path, label) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`${label}包含符号链接或 reparse 点：${path}`);
  if (!stats.isFile()) throw new Error(`${label}不是普通文件：${path}`);
  return stats;
}

async function collectMatchingFiles(root, directory, predicate, label) {
  const directoryPath = join(root, directory);
  await assertDirectory(directoryPath, label);
  const result = [];
  async function visit(currentPath, currentRelative) {
    const entries = (await readdir(currentPath, { withFileTypes: true })).sort((left, right) => stableCompare(left.name, right.name));
    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      const entryRelative = normalize(join(currentRelative, entry.name));
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) throw new Error(`${label}包含符号链接或 reparse 点：${entryRelative}`);
      if (stats.isDirectory()) {
        if (!excludedDirectoryNames.has(entry.name)) await visit(entryPath, entryRelative);
        continue;
      }
      if (stats.isFile() && predicate(entryRelative)) result.push(entryRelative);
    }
  }
  await visit(directoryPath, normalize(directory));
  return result.sort(stableCompare);
}

async function collectExactFiles(root, paths, label) {
  const result = [];
  for (const path of paths) {
    const absolutePath = join(root, path);
    await assertRegularSourceFile(absolutePath, `${label}/${path}`);
    result.push(normalize(path));
  }
  return result.sort(stableCompare);
}

async function collectMigrationFiles(root) {
  const directory = join(root, 'db', 'migrations');
  await assertDirectory(directory, 'yuqu-server/db/migrations');
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => stableCompare(left.name, right.name));
  const result = [];
  for (const entry of entries) {
    const path = join('db', 'migrations', entry.name);
    const stats = await lstat(join(root, path));
    if (stats.isSymbolicLink()) throw new Error(`迁移目录包含符号链接或 reparse 点：${path}`);
    if (stats.isFile() && /^\d{4}.*\.sql$/i.test(entry.name)) result.push(normalize(path));
  }
  return result.sort(stableCompare);
}

async function collectBridgeUnexpectedTests(bridgeRoot) {
  const directory = join(bridgeRoot, 'tests');
  await assertDirectory(directory, 'CodexBridge/tests');
  const unexpected = [];
  async function visit(currentPath, currentRelative) {
    const entries = (await readdir(currentPath, { withFileTypes: true })).sort((left, right) => stableCompare(left.name, right.name));
    for (const entry of entries) {
      const path = join(currentPath, entry.name);
      const relativePath = normalize(join(currentRelative, entry.name));
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw new Error(`CodexBridge/tests包含符号链接或 reparse 点：${relativePath}`);
      if (stats.isDirectory()) {
        if (!excludedDirectoryNames.has(entry.name)) await visit(path, relativePath);
      } else if (stats.isFile() && !['.json', '.mjs', '.ts'].includes(extname(entry.name).toLowerCase())) {
        unexpected.push(relativePath);
      }
    }
  }
  await visit(directory, 'tests');
  return unexpected.sort(stableCompare);
}

async function hashFile(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function copySourceFiles(sourceRoot, outputRoot, project, paths) {
  const records = [];
  for (const sourcePath of paths.sort(stableCompare)) {
    const sourceAbsolute = join(sourceRoot, sourcePath);
    await assertPathAncestorsHaveNoLinks(sourceAbsolute, `${project}/${sourcePath}`);
    const sourceStats = await assertRegularSourceFile(sourceAbsolute, `${project}/${sourcePath}`);
    const sourceHash = await hashFile(sourceAbsolute);
    const destinationPath = join(outputRoot, project, sourcePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourceAbsolute, destinationPath, 0x1);
    const copied = await hashFile(destinationPath);
    if (copied.bytes !== sourceStats.size || copied.bytes !== sourceHash.bytes || copied.sha256 !== sourceHash.sha256) throw new Error(`复制字节或摘要不一致：${project}/${sourcePath}`);
    records.push({ sourceProject: project, path: sourcePath.replaceAll('\\', '/'), archivePath: `${project}/${sourcePath.replaceAll('\\', '/')}`, bytes: sourceHash.bytes, sha256: sourceHash.sha256 });
  }
  return records.sort((left, right) => stableCompare(left.path, right.path));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createArchive(outputRoot, archivePath, project, fileRecords, emptyDirectories = []) {
  const entries = [...fileRecords.map(record => record.archivePath), ...emptyDirectories.map(path => `${project}/${path}`)].sort(stableCompare);
  if (entries.length === 0) throw new Error(`没有可归档文件：${project}`);
  await execFile('tar', ['-czf', archivePath, '-C', outputRoot, ...entries], { windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
  const stats = await lstat(archivePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`归档未生成普通文件：${archivePath}`);
  return { bytes: stats.size, sha256: (await hashFile(archivePath)).sha256 };
}

async function collectSources(repository, bridgeRoot) {
  const yuqu = [];
  yuqu.push(...await collectExactFiles(repository, ['package.json', 'package-lock.json', 'tsconfig.json', '.dockerignore'], 'yuqu-server'));
  yuqu.push(...await collectExactFiles(repository, ['apps/web/package.json', 'apps/web/next.config.ts', 'apps/web/next-env.d.ts', 'apps/web/tsconfig.json'], 'yuqu-server'));
  yuqu.push(...await collectMatchingFiles(repository, 'apps/web/app', path => ['.css', '.svg', '.ts', '.tsx'].includes(extname(path).toLowerCase()) || webImageExtensions.has(extname(path).toLowerCase()), 'yuqu-server/apps/web/app'));
  yuqu.push(...await collectMatchingFiles(repository, 'apps/web/lib', path => ['.css', '.svg', '.ts', '.tsx'].includes(extname(path).toLowerCase()) || webImageExtensions.has(extname(path).toLowerCase()), 'yuqu-server/apps/web/lib'));
  yuqu.push(...await collectExactFiles(repository, ['packages/contracts/package.json', 'packages/domain/package.json'], 'yuqu-server'));
  yuqu.push(...await collectMatchingFiles(repository, 'packages/contracts/src', path => extname(path).toLowerCase() === '.ts', 'yuqu-server/packages/contracts/src'));
  yuqu.push(...await collectMatchingFiles(repository, 'packages/domain/src', path => extname(path).toLowerCase() === '.ts', 'yuqu-server/packages/domain/src'));
  yuqu.push(...await collectMigrationFiles(repository));
  yuqu.push(...await collectExactFiles(repository, ['deploy/Dockerfile', 'deploy/compose.yaml'], 'yuqu-server'));
  yuqu.push(...await collectExactFiles(repository, ['scripts/generate-audio-fixture.mjs', 'scripts/migrate.mjs', 'scripts/dev-web.mjs'], 'yuqu-server'));
  yuqu.push(...await collectMatchingFiles(repository, 'workers/ingestion', path => extname(path).toLowerCase() === '.mjs' || path.replaceAll('\\', '/').split('/').at(-1) === 'package.json', 'yuqu-server/workers/ingestion'));
  yuqu.push(...await collectExactFiles(repository, ['workers/codex-bridge/package.json'], 'yuqu-server'));

  const bridge = [];
  bridge.push(...await collectExactFiles(bridgeRoot, ['package.json', 'pnpm-lock.yaml', 'tsconfig.json'], 'codex-bridge'));
  bridge.push(...await collectMatchingFiles(bridgeRoot, 'src', path => ['.json', '.mjs', '.ts'].includes(extname(path).toLowerCase()), 'codex-bridge/src'));
  // These non-code resources are resolved by the shared Cat adapter at runtime.
  // Keep an exact allow-list rather than omitting them or copying arbitrary assets.
  bridge.push(...await collectExactFiles(bridgeRoot, [
    'src/adapters/cat-island/.agents/skills/cat-identity-imagegen/SKILL.md',
    'src/adapters/cat-island/.agents/skills/cat-coat-map-imagegen/SKILL.md',
    'src/adapters/cat-island/public/assets/style/cat-sprite-style-v1.png',
    'src/adapters/cat-island/public/assets/style/cat-coat-map-six-view-v1.png'
  ], 'codex-bridge/resources'));
  bridge.push(...await collectMatchingFiles(bridgeRoot, 'scripts', path => ['.json', '.mjs', '.ts'].includes(extname(path).toLowerCase()), 'codex-bridge/scripts'));
  bridge.push(...await collectMatchingFiles(bridgeRoot, 'tests', path => ['.json', '.mjs', '.ts'].includes(extname(path).toLowerCase()), 'codex-bridge/tests'));
  const bridgeUnexpectedTests = await collectBridgeUnexpectedTests(bridgeRoot);
  return { yuqu: [...new Set(yuqu)].sort(stableCompare), bridge: [...new Set(bridge)].sort(stableCompare), bridgeUnexpectedTests };
}

async function ensureOutputIsNewAndExternal(output, bridge) {
  await assertPathAncestorsHaveNoLinks(output, '输出路径');
  await assertPathAncestorsHaveNoLinks(repositoryRoot, 'YuQuLibrary 源树');
  await assertPathAncestorsHaveNoLinks(bridge, 'CodexBridge 源树');
  const bridgeStats = await lstat(bridge);
  if (bridgeStats.isSymbolicLink() || !bridgeStats.isDirectory()) throw new Error('--bridge 必须指向普通目录，不能是符号链接或 reparse 点');
  if (isWithin(repositoryRoot, output)) throw new Error('--output 不能位于 YuQuLibrary 源树内');
  if (isWithin(bridge, output)) throw new Error('--output 不能位于 CodexBridge 源树内');
  try {
    const outputStats = await lstat(output);
    if (outputStats.isSymbolicLink()) throw new Error('--output 已存在且是符号链接或 reparse 点');
    throw new Error('--output 必须是不存在的新目录');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function main() {
  const { output, bridge } = parseArguments(process.argv.slice(2));
  await ensureOutputIsNewAndExternal(output, bridge);
  const sources = await collectSources(repositoryRoot, bridge);
  await mkdir(output, { recursive: true });
  await assertDirectory(output, '输出目录');
  await mkdir(join(output, yuquOutputName, 'apps', 'web', 'public'), { recursive: true });
  const yuquRecords = await copySourceFiles(repositoryRoot, output, yuquOutputName, sources.yuqu);
  const bridgeRecords = await copySourceFiles(bridge, output, bridgeOutputName, sources.bridge);
  const allRecords = [...yuquRecords, ...bridgeRecords];
  const migrationRecords = yuquRecords.filter(record => record.path.startsWith('db/migrations/')).map((record, index) => ({ order: index + 1, path: record.path, bytes: record.bytes, sha256: record.sha256 }));
  await mkdir(join(output, 'manifests'), { recursive: true });
  await writeJson(join(output, 'manifests', `${yuquOutputName}.json`), { schemaVersion: 1, sourceProject: yuquOutputName, files: yuquRecords });
  await writeJson(join(output, 'manifests', `${bridgeOutputName}.json`), { schemaVersion: 1, sourceProject: bridgeOutputName, files: bridgeRecords, excludedTestFiles: sources.bridgeUnexpectedTests });
  await writeJson(join(output, 'migration-list.json'), { schemaVersion: 1, sourceProject: yuquOutputName, count: migrationRecords.length, files: migrationRecords });
  const archiveDirectory = join(output, 'archives');
  await mkdir(archiveDirectory);
  const yuquArchiveName = `${yuquOutputName}.tar.gz`;
  const bridgeArchiveName = `${bridgeOutputName}.tar.gz`;
  const yuquArchive = await createArchive(output, join(archiveDirectory, yuquArchiveName), yuquOutputName, yuquRecords, ['apps/web/public']);
  const bridgeArchive = await createArchive(output, join(archiveDirectory, bridgeArchiveName), bridgeOutputName, bridgeRecords);
  const topLevelManifest = {
    schemaVersion: 1,
    sourceRoots: { yuquServer: yuquOutputName, codexBridge: bridgeOutputName },
    files: allRecords,
    fileCount: allRecords.length,
    projects: [
      { sourceProject: yuquOutputName, fileCount: yuquRecords.length, bytes: yuquRecords.reduce((sum, record) => sum + record.bytes, 0), manifest: `manifests/${yuquOutputName}.json` },
      { sourceProject: bridgeOutputName, fileCount: bridgeRecords.length, bytes: bridgeRecords.reduce((sum, record) => sum + record.bytes, 0), manifest: `manifests/${bridgeOutputName}.json` }
    ],
    migrations: { manifest: 'migration-list.json', count: migrationRecords.length },
    archives: [
      { sourceProject: yuquOutputName, path: `archives/${yuquArchiveName}`, fileCount: yuquRecords.length, bytes: yuquArchive.bytes, sha256: yuquArchive.sha256 },
      { sourceProject: bridgeOutputName, path: `archives/${bridgeArchiveName}`, fileCount: bridgeRecords.length, bytes: bridgeArchive.bytes, sha256: bridgeArchive.sha256 }
    ],
    excludedTestFiles: sources.bridgeUnexpectedTests,
    excludedInputs: ['.env*', 'runtime', 'models', 'media', 'signatures', 'node_modules', '.next', '.local', 'cache', 'apps/web/public/audio']
  };
  await writeJson(join(output, 'manifest.json'), topLevelManifest);
  console.log(JSON.stringify({ output, fileCount: allRecords.length, migrations: migrationRecords.length, excludedTestFiles: sources.bridgeUnexpectedTests, archives: topLevelManifest.archives }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`发布候选打包失败：${error?.message ?? error}`);
  process.exitCode = 1;
}
