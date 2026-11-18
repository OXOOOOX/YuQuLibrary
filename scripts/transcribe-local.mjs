import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const runner = fileURLToPath(new URL('../workers/transcription/runner.py', import.meta.url));
const manifest = fileURLToPath(new URL('../workers/transcription/model-manifest.json', import.meta.url));
const settings = ['YUQU_ASR_PYTHON', 'YUQU_ASR_MODEL_DIR', 'YUQU_ASR_ALIGNER_DIR'];
for (const key of settings) {
  const value = process.env[key];
  if (!value || !isAbsolute(value) || !existsSync(value)) throw new Error(`请先配置有效的绝对路径 ${key}，见 workers/transcription/README.md。`);
}
// The inference process needs system paths, not the application's SMTP/database secrets.
const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'userprofile',
  'localappdata', 'appdata', 'programdata', 'programfiles', 'programfiles(x86)', 'systemdrive',
  'number_of_processors', 'processor_architecture', 'cuda_path', 'cuda_path_v12_8', 'cuda_visible_devices']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
Object.assign(env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1',
  HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', TOKENIZERS_PARALLELISM: 'false' });
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.env.YUQU_ASR_PYTHON, [runner, '--model-path', process.env.YUQU_ASR_MODEL_DIR,
    '--aligner-path', process.env.YUQU_ASR_ALIGNER_DIR, '--manifest', manifest, ...process.argv.slice(2)],
    { env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
});
process.exitCode = Number(code);
