import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import JSON5 from 'json5';

const root = process.cwd();
const excluded = new Set(['node_modules', '.git', '.next', '.hvigor', 'oh_modules', 'build', 'dist', '.idea']);
let count = 0;
async function visit(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(item.name) || item.name.startsWith('.node_modules-')) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) await visit(path);
    else if (/\.json5?$/.test(item.name) && item.name !== 'package-lock.json') {
      const text = await readFile(path, 'utf8');
      try { JSON5.parse(text); count++; }
      catch (error) { throw new Error(`${relative(root, path)}: ${error.message}`); }
    }
  }
}
await visit(root);
console.log(`${count} 个 JSON/JSON5 配置可解析；此检查不代表 ArkTS 编译或资源链接验证。`);
