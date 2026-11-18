import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeStorageFiles } from '../packages/domain/src/storage-cleanup.ts';
import { storageLimitBytes } from '../packages/domain/src/storage-limits.ts';

const key = () => `${randomUUID()}-${randomUUID()}.media`;
async function withDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(),'yuqu-cleanup-test-'));
  try { await work(directory); }
  finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir(),'yuqu-cleanup-test-'))); await rm(directory,{recursive:true,force:true}); }
}
test('cleanup removes only its generated media/partial names and accepts already missing files', async () => withDirectory(async directory => {
  const target=key(),other=key();
  await writeFile(join(directory,target),'audio');await writeFile(join(directory,`${target}.part`),'partial');await writeFile(join(directory,other),'keep');
  await removeStorageFiles(directory,target,true);
  await assert.rejects(access(join(directory,target)));await assert.rejects(access(join(directory,`${target}.part`)));
  assert.equal(await readFile(join(directory,other),'utf8'),'keep');await removeStorageFiles(directory,target,true);
}));
test('cleanup rejects traversal, unexpected names, relative bases and directory targets', async () => withDirectory(async directory => {
  const target=key();await mkdir(join(directory,target));
  for(const bad of ['../outside.media','/outside.media','*.media','fixture-pcm-v1',`${target}.part`]) await assert.rejects(removeStorageFiles(directory,bad),{code:'CLEANUP_PATH_INVALID'});
  await assert.rejects(removeStorageFiles('.',target),{code:'CLEANUP_PATH_INVALID'});
  await assert.rejects(removeStorageFiles(directory,target),{code:'CLEANUP_PATH_INVALID'});await access(join(directory,target));
}));
test('cleanup does not follow a symlink to another file', async t => withDirectory(async directory => {
  const target=key(),other=key();await writeFile(join(directory,other),'keep');
  try { await symlink(join(directory,other),join(directory,target),'file'); }
  catch(error) { if(error.code==='EPERM'){t.skip('This Windows account cannot create file symlinks');return;}throw error; }
  await assert.rejects(removeStorageFiles(directory,target),{code:'CLEANUP_PATH_INVALID'});assert.equal(await readFile(join(directory,other),'utf8'),'keep');
}));
test('storage quota defaults to one GiB and rejects invalid or unsafe configuration', () => {
  const before=process.env.YUQU_USER_STORAGE_LIMIT_BYTES;
  try {
    delete process.env.YUQU_USER_STORAGE_LIMIT_BYTES;assert.equal(storageLimitBytes(),1024**3);
    process.env.YUQU_USER_STORAGE_LIMIT_BYTES='2147483648';assert.equal(storageLimitBytes(),2*1024**3);
    for(const raw of ['0','-1','Infinity','1.5','9007199254740993','']){process.env.YUQU_USER_STORAGE_LIMIT_BYTES=raw;assert.throws(storageLimitBytes,{code:'STORAGE_CONFIG_INVALID'});}
  } finally {if(before===undefined)delete process.env.YUQU_USER_STORAGE_LIMIT_BYTES;else process.env.YUQU_USER_STORAGE_LIMIT_BYTES=before;}
});
