import { fileURLToPath } from 'node:url';

// Loading here avoids forwarding Node's env-file CLI flag through Next's
// child-process NODE_OPTIONS, where that flag is not supported.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const next = new URL('../node_modules/next/dist/bin/next', import.meta.url);
const hostname = process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';
process.argv = [process.execPath, fileURLToPath(next), 'dev', '--hostname', hostname];
await import(next.href);
