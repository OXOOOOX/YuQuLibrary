// Separate from the email send-budget lock (5173802) and migration lock (5173801).
export const TRANSCRIPTION_WORKER_LOCK = 5173803;

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const validOwner = owner => owner?.kind === 'yuqu-asr-model-v1' && validPid(owner.pid) &&
  typeof owner.nonce === 'string' && owner.nonce.length > 0 &&
  (owner.childPid === undefined || validPid(owner.childPid));

/** One model owner on this computer, including workers connected to different databases. */
export async function acquireModelLock(modelDirectory) {
  const canonical = await realpath(modelDirectory);
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const directory = join(tmpdir(), 'yuqu-asr-model-locks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${key}.json`), nonce = randomUUID();
  const legacyGate = join(directory, `${key}.gate`);
  const gatePath = join(directory, `${key}.gate.sqlite`);
  // The OS releases SQLite's write lock when a worker is killed. Directory
  // locks cannot safely distinguish an interrupted mkdir from a live claimant.
  const gated = operation => {
    const database = new DatabaseSync(gatePath);
    let transaction = false;
    try {
      database.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;');
      transaction = true;
      // An older worker may own this directory. Never guess or remove it.
      if (existsSync(legacyGate)) throw new Error('Local ASR model ownership is being checked');
      const value = operation();
      database.exec('COMMIT');
      transaction = false;
      return value;
    } finally {
      if (transaction) { try { database.exec('ROLLBACK'); } catch {} }
      database.close();
    }
  };
  const readOwner = () => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('Local ASR model ownership is invalid'); }
  };
  const writeOwner = owner => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(owner));
      fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const ownRecord = () => {
    const owner = readOwner();
    if (!validOwner(owner) || owner.nonce !== nonce || owner.pid !== process.pid) {
      throw new Error('Local ASR model ownership lost');
    }
    return owner;
  };
  gated(() => {
    const old = readOwner();
    if (old !== undefined && (!validOwner(old) || alive(old.pid) || (old.childPid !== undefined && alive(old.childPid)))) {
      throw new Error('Local ASR model already in use');
    }
    writeOwner({ kind: 'yuqu-asr-model-v1', pid: process.pid, nonce });
  });
  const release = async () => gated(() => {
    const owner = readOwner();
    if (!owner || owner.nonce !== nonce) return;
    if (!validOwner(owner) || (owner.childPid !== undefined && alive(owner.childPid))) {
      throw new Error('Local ASR model child is still alive');
    }
    unlinkSync(path);
  });
  release.attachChild = async pid => gated(() => {
    if (!validPid(pid) || pid === process.pid) throw new Error('Invalid inference child PID');
    const owner = ownRecord();
    if (owner.childPid !== undefined) throw new Error('Local ASR model child already attached');
    writeOwner({ ...owner, childPid: pid });
  });
  release.detachChild = async pid => gated(() => {
    const owner = ownRecord();
    if (owner.childPid !== pid) throw new Error('Local ASR model child ownership lost');
    if (alive(pid)) throw new Error('Local ASR model child is still alive');
    delete owner.childPid;
    writeOwner(owner);
  });
  return release;
}
