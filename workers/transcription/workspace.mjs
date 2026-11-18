import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const WORKSPACE_MARKER = '.yuqu-asr-owner.json';
const KIND = 'yuqu-asr-workspace-v1';
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

async function cacheRoot(directory) {
  if (!isAbsolute(directory)) throw new Error('Invalid inference cache directory');
  const path = resolve(directory), info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid inference cache directory');
  return realpath(path);
}

async function inspect(root, path) {
  try {
    const name = relative(root, path);
    if (!/^\.asr-[A-Za-z0-9]+$/.test(name) || isAbsolute(name) || name.includes(sep) ||
        !samePath(dirname(path), root)) return null;
    const directory = await lstat(path);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !samePath(await realpath(path), path)) return null;
    const markerPath = join(path, WORKSPACE_MARKER), marker = await lstat(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.size > 4096) return null;
    const owner = JSON.parse(await readFile(markerPath, 'utf8'));
    if (owner?.kind !== KIND || !validPid(owner.nodePid) ||
        typeof owner.nonce !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner.nonce) ||
        owner.workspace !== name || typeof owner.root !== 'string' || !samePath(owner.root, root) ||
        (owner.childPid !== undefined && !validPid(owner.childPid)) ||
        Object.keys(owner).some(key => !['kind', 'nodePid', 'nonce', 'workspace', 'root', 'childPid'].includes(key))) return null;
    return { owner, directory };
  } catch { return null; }
}

async function containsNoLinks(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return false;
  if (!info.isDirectory()) return info.isFile();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !await containsNoLinks(join(path, entry.name))) return false;
  }
  return true;
}

async function removeMarked(root, path, expectedNonce = null) {
  const initial = await inspect(root, path);
  if (!initial) return false;
  const canRemove = value => value !== null && value.owner.nonce === initial.owner.nonce &&
    value.directory.dev === initial.directory.dev && value.directory.ino === initial.directory.ino &&
    (expectedNonce === null ? !alive(value.owner.nodePid) :
      value.owner.nonce === expectedNonce && value.owner.nodePid === process.pid) &&
    (value.owner.childPid === undefined || !alive(value.owner.childPid));
  if (!canRemove(initial)) return false;
  try {
    if (!await containsNoLinks(path)) return false;
    // Keep the ownership marker until all payloads are gone. An interrupted or
    // partially failed cleanup can then be retried without guessing ownership.
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === WORKSPACE_MARKER) continue;
      const target = resolve(path, entry.name);
      if (!samePath(dirname(target), path) || !await containsNoLinks(target) ||
          !canRemove(await inspect(root, path))) return false;
      // Both the absolute parent and the current ownership marker were checked.
      await rm(target, { recursive: true, force: true });
    }
    if (!canRemove(await inspect(root, path))) return false;
    const remaining = await readdir(path);
    if (remaining.length !== 1 || remaining[0] !== WORKSPACE_MARKER) return false;
    await unlink(join(path, WORKSPACE_MARKER));
    await rmdir(path);
    return true;
  } catch { return false; }
}

async function recoverRoot(root) {
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\.asr-[A-Za-z0-9]+$/.test(entry.name)) continue;
    if (await removeMarked(root, resolve(root, entry.name))) removed++;
  }
  return removed;
}

/** Recover only abandoned, positively identified inference workspaces. */
export async function recoverTranscriptionWorkspaces(directory) {
  return recoverRoot(await cacheRoot(directory));
}

async function writeMarker(path, owner) {
  const temporary = join(path, `.yuqu-asr-owner-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(owner));
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, join(path, WORKSPACE_MARKER));
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function createTranscriptionWorkspace(directory) {
  const root = await cacheRoot(directory);
  await recoverRoot(root);
  const path = await mkdtemp(join(root, '.asr-'));
  const owner = { kind: KIND, nodePid: process.pid, nonce: randomUUID(), workspace: basename(path), root };
  try { await writeMarker(path, owner); }
  catch (error) { await rmdir(path).catch(() => {}); throw error; }
  return {
    path,
    async attachChild(pid) {
      const current = await inspect(root, path);
      if (!validPid(pid) || pid === process.pid || !current || current.owner.nonce !== owner.nonce ||
          current.owner.nodePid !== process.pid || current.owner.childPid !== undefined) {
        throw new Error('Invalid inference workspace ownership');
      }
      await writeMarker(path, { ...current.owner, childPid: pid });
    },
    async remove() {
      if (!await removeMarked(root, path, owner.nonce)) throw new Error('Inference workspace cleanup deferred');
    },
  };
}
