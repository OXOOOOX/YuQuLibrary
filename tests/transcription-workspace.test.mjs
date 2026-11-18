import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createTranscriptionWorkspace, recoverTranscriptionWorkspaces, WORKSPACE_MARKER } from '../workers/transcription/workspace.mjs';

const moduleUrl = new URL('../workers/transcription/workspace.mjs', import.meta.url).href;
const makeRoot = () => mkdtemp(join(tmpdir(), 'yuqu-asr-workspace-test-'));
async function cleanRoot(root) {
  const absolute = resolve(root);
  assert.equal(dirname(absolute).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(basename(absolute).startsWith('yuqu-asr-workspace-test-'));
  await rm(absolute, { recursive: true, force: true });
}
async function abandoned(root, childPid = null) {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import {mkdir,writeFile} from 'node:fs/promises'; import {join} from 'node:path';
     const {createTranscriptionWorkspace}=await import(${JSON.stringify(moduleUrl)});
     const workspace=await createTranscriptionWorkspace(${JSON.stringify(root)});
     if(${JSON.stringify(childPid)}!==null)await workspace.attachChild(${JSON.stringify(childPid)});
     await mkdir(join(workspace.path,'decoded'));await writeFile(join(workspace.path,'decoded','audio.wav'),'controlled decoded audio');
     console.log(JSON.stringify({path:workspace.path,pid:process.pid}));`], { windowsHide: true });
  return JSON.parse(stdout);
}
async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
}

test('new workspaces carry a scoped marker; live owners survive scans and can clean their own files', async () => {
  const root = await makeRoot();
  try {
    const workspace = await createTranscriptionWorkspace(root);
    const owner = JSON.parse(await readFile(join(workspace.path, WORKSPACE_MARKER), 'utf8'));
    assert.equal(owner.kind, 'yuqu-asr-workspace-v1');
    assert.equal(owner.nodePid, process.pid);
    assert.equal(owner.root, await realpath(root));
    assert.equal(owner.workspace, basename(workspace.path));
    assert.match(owner.nonce, /^[a-f0-9-]{36}$/);
    await writeFile(join(workspace.path, 'decoded.wav'), 'owned decoded audio');
    assert.equal(await recoverTranscriptionWorkspaces(root), 0);
    assert.equal(await readFile(join(workspace.path, 'decoded.wav'), 'utf8'), 'owned decoded audio');
    await workspace.remove();
    assert.deepEqual(await readdir(root), []);
  } finally { await cleanRoot(root); }
});

test('the next workspace creation reclaims marked files left by a real exited Node process', async () => {
  const root = await makeRoot();
  try {
    const old = await abandoned(root);
    assert.throws(() => process.kill(old.pid, 0), { code: 'ESRCH' });
    assert.equal(await readFile(join(old.path, 'decoded', 'audio.wav'), 'utf8'), 'controlled decoded audio');
    const next = await createTranscriptionWorkspace(root);
    await assert.rejects(readFile(join(old.path, WORKSPACE_MARKER)), { code: 'ENOENT' });
    assert.deepEqual(await readdir(root), [basename(next.path)]);
    await next.remove();
  } finally { await cleanRoot(root); }
});

test('a surviving child protects an exited owner workspace until that child exits', async () => {
  const root = await makeRoot();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    const old = await abandoned(root, child.pid);
    assert.equal(await recoverTranscriptionWorkspaces(root), 0);
    assert.equal(await readFile(join(old.path, 'decoded', 'audio.wav'), 'utf8'), 'controlled decoded audio');
    await killChild(child);
    assert.equal(await recoverTranscriptionWorkspaces(root), 1);
    assert.deepEqual(await readdir(root), []);
  } finally { await killChild(child); await cleanRoot(root); }
});

test('normal cleanup also refuses a live child and ownership marker replacement', async () => {
  const root = await makeRoot();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    const workspace = await createTranscriptionWorkspace(root);
    await workspace.attachChild(child.pid);
    await assert.rejects(workspace.remove(), /cleanup deferred/);
    await assert.rejects(workspace.attachChild(child.pid), /ownership/);
    await killChild(child);
    const marker = join(workspace.path, WORKSPACE_MARKER);
    const original = await readFile(marker, 'utf8');
    const replaced = JSON.parse(original); replaced.nonce = '00000000-0000-0000-0000-000000000000';
    await writeFile(marker, JSON.stringify(replaced));
    await assert.rejects(workspace.remove(), /cleanup deferred/);
    await writeFile(marker, original);
    await workspace.remove();
  } finally { await killChild(child); await cleanRoot(root); }
});

test('unknown directories, malformed markers, path mismatches and invalid child PIDs are preserved', async () => {
  const root = await makeRoot();
  try {
    const old = await abandoned(root);
    const template = JSON.parse(await readFile(join(old.path, WORKSPACE_MARKER), 'utf8'));
    await writeFile(join(old.path, WORKSPACE_MARKER), 'not JSON');
    for (const [name, change] of [['.asr-unknown', null], ['.asr-invalidchild', {childPid: 0}],
      ['.asr-wrongroot', {root: dirname(root)}], ['.asr-wrongname', {workspace: '../outside'}],
      ['.asr-wrongkind', {kind: 'not-yuqu'}], ['.asr-wrongnonce', {nonce: 'guess'}]]) {
      const path = join(root, name); await mkdir(path); await writeFile(join(path, 'keep.txt'), 'user data');
      if (change) await writeFile(join(path, WORKSPACE_MARKER), JSON.stringify({...template,workspace:name,...change}));
    }
    await writeFile(join(root, 'user-audio.mp3'), 'user audio');
    const before = (await readdir(root)).sort();
    assert.equal(await recoverTranscriptionWorkspaces(root), 0);
    assert.deepEqual((await readdir(root)).sort(), before);
    assert.equal(await readFile(join(root, '.asr-unknown', 'keep.txt'), 'utf8'), 'user data');
    assert.equal(await readFile(join(root, 'user-audio.mp3'), 'utf8'), 'user audio');
  } finally { await cleanRoot(root); }
});

test('workspace and nested directory links never authorize removing their targets', async () => {
  const root = await makeRoot(), outside = await makeRoot();
  try {
    await writeFile(join(outside, 'keep.txt'), 'outside user data');
    const old = await abandoned(root);
    await symlink(outside, join(root, '.asr-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(outside, join(old.path, 'linked-decoder'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await recoverTranscriptionWorkspaces(root), 0);
    await assert.rejects(createTranscriptionWorkspace(join(root, '.asr-link')), /cache directory/);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside user data');
    assert.equal(await readFile(join(old.path, 'decoded', 'audio.wav'), 'utf8'), 'controlled decoded audio');
    assert.ok((await readdir(root)).includes('.asr-link'));
  } finally { await cleanRoot(root); await cleanRoot(outside); }
});
