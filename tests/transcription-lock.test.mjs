import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir, realpath, mkdir, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { acquireModelLock } from '../workers/transcription/lock.mjs';

const lockModule = new URL('../workers/transcription/lock.mjs', import.meta.url).href;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function waitUntil(condition, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for controlled child');
    await delay(25);
  }
}
async function pathsFor(directory) {
  const canonical = await realpath(directory);
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const prefix = join(tmpdir(), 'yuqu-asr-model-locks', key);
  return { owner: `${prefix}.json`, gate: `${prefix}.gate`, sqlite: `${prefix}.gate.sqlite` };
}
async function cleanLockFiles(directory) {
  const paths = await pathsFor(directory);
  for (const path of [paths.owner, paths.sqlite, `${paths.sqlite}-journal`]) {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await rmdir(directory);
}
function childLines(child) {
  const lines = [];
  let pending = '';
  child.stdout.setEncoding('utf8').on('data', block => {
    pending += block;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      lines.push(pending.slice(0, index).replace(/\r$/, '')); pending = pending.slice(index + 1);
    }
  });
  return async () => { await waitUntil(() => lines.length > 0); return lines.shift(); };
}
async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
}

test('model ownership excludes a second worker and recovers after the owner process exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-model-lock-test-'));
  const release = await acquireModelLock(directory);
  try { await assert.rejects(acquireModelLock(directory), /already in use/); }
  finally { await release(); }
  const moduleUrl = new URL('../workers/transcription/lock.mjs', import.meta.url).href;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `const {acquireModelLock}=await import(${JSON.stringify(moduleUrl)});await acquireModelLock(${JSON.stringify(directory)});`], { windowsHide: true });
  const recovered = await acquireModelLock(directory);
  await recovered(); await cleanLockFiles(directory);
});

test('a live inference child prevents release, detach and a second model owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-model-child-test-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const release = await acquireModelLock(directory);
  try {
    await release.attachChild(child.pid);
    await assert.rejects(release.attachChild(child.pid), /already attached/);
    await assert.rejects(release.detachChild(child.pid), /still alive/);
    await assert.rejects(release(), /still alive/);
    await assert.rejects(acquireModelLock(directory), /already in use/);
    await killChild(child);
    await release.detachChild(child.pid);
    await release();
    const next = await acquireModelLock(directory);
    await next();
  } finally { await killChild(child); await release(); await cleanLockFiles(directory); }
});

test('dead Node owner cannot release a surviving inference child to another worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-orphan-lock-test-'));
  // The test owns this process handle; the short-lived owner only records its PID.
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `const {acquireModelLock}=await import(${JSON.stringify(lockModule)});
       const lease=await acquireModelLock(${JSON.stringify(directory)}); await lease.attachChild(${child.pid});`], { windowsHide: true });
    await assert.rejects(acquireModelLock(directory), /already in use/);
    await killChild(child);
    const next = await acquireModelLock(directory);
    await next();
  } finally { await killChild(child); await cleanLockFiles(directory); }
});

test('unknown legacy gate fails closed and does not modify a live owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-legacy-gate-test-'));
  const release = await acquireModelLock(directory);
  const paths = await pathsFor(directory);
  const original = await readFile(paths.owner, 'utf8');
  await mkdir(paths.gate);
  try {
    await assert.rejects(acquireModelLock(directory), /being checked/);
    assert.equal(await readFile(paths.owner, 'utf8'), original);
  } finally { await rmdir(paths.gate); await release(); await cleanLockFiles(directory); }
});

test('SQLite gate is exclusive across processes and recovers when its holder is killed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-sqlite-gate-test-'));
  const paths = await pathsFor(directory);
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import {DatabaseSync} from 'node:sqlite';
     const database=new DatabaseSync(${JSON.stringify(paths.sqlite)});
     database.exec('BEGIN IMMEDIATE'); console.log('held'); setInterval(()=>{},1000);`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const nextLine = childLines(holder);
  try {
    assert.equal(await nextLine(), 'held');
    await assert.rejects(acquireModelLock(directory), /locked/);
    await killChild(holder);
    const next = await acquireModelLock(directory);
    await next();
  } finally { await killChild(holder); await cleanLockFiles(directory); }
});

for (const registered of [false, true]) {
  test(`parent death ${registered ? 'after' : 'before'} child registration closes the Python guard`, async t => {
    const python = process.env.YUQU_TEST_PYTHON || 'python';
    try { await promisify(execFile)(python, ['--version'], { windowsHide: true, timeout: 5000 }); }
    catch { t.skip('A local Python is required for the parent-pipe process test'); return; }
    const directory = await mkdtemp(join(tmpdir(), 'yuqu-parent-pipe-test-'));
    const source = fileURLToPath(new URL('../workers/transcription/', import.meta.url));
    const pythonCode = `import sys,time\nsys.path.insert(0,${JSON.stringify(source)})\nfrom parent_pipe import ParentPipe\nwith ParentPipe() as parent:\n print('waiting',flush=True)\n parent.expect('start')\n print('started',flush=True)\n time.sleep(60)\n`;
    const parent = spawn(process.execPath, ['--input-type=module', '-e',
      `import {spawn} from 'node:child_process';
       const {acquireModelLock}=await import(${JSON.stringify(lockModule)});
       const lease=await acquireModelLock(${JSON.stringify(directory)});
       const child=spawn(${JSON.stringify(python)},['-u','-c',${JSON.stringify(pythonCode)}],{windowsHide:true,stdio:['pipe','pipe','ignore']});
       console.log(JSON.stringify({pid:child.pid})); child.stdout.pipe(process.stdout);
       process.stdin.once('data',async()=>{await lease.attachChild(child.pid);child.stdin.write('start\\n');});`],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const nextLine = childLines(parent);
    let childPid;
    try {
      childPid = JSON.parse(await nextLine()).pid;
      assert.equal(await nextLine(), 'waiting');
      const paths = await pathsFor(directory);
      assert.equal(JSON.parse(await readFile(paths.owner, 'utf8')).childPid, undefined);
      if (registered) {
        parent.stdin.write('attach\n');
        assert.equal(await nextLine(), 'started');
        assert.equal(JSON.parse(await readFile(paths.owner, 'utf8')).childPid, childPid);
      }
      await killChild(parent);
      await waitUntil(() => !alive(childPid));
      const next = await acquireModelLock(directory);
      await next();
    } finally {
      await killChild(parent);
      if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
      await cleanLockFiles(directory);
    }
  });
}
