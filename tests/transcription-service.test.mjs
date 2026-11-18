import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, alive, readJson, serviceEnvironment, servicePaths, serviceStatus } from '../workers/transcription/service-runtime.mjs';
import { restartDelay, supervise } from '../workers/transcription/service-supervisor.mjs';

const secret = 'test-only-private-output-never-publish-7ce83';
const responsiveChild = `
  console.log(${JSON.stringify(secret)});
  console.error(${JSON.stringify(secret)});
  const report = () => process.send({type:'status',phase:'idle',jobId:null,completedMs:0,durationMs:0,privateOutput:${JSON.stringify(secret)}});
  process.on('message', message => { if(message.type==='stop') process.exit(0); });
  process.on('disconnect', () => process.exit(0));
  report(); setInterval(report, 50);
  if(process.env.YUQU_TEST_CHILD_RUN==='1' && process.env.YUQU_TEST_CRASH_FIRST==='1') setTimeout(() => process.exit(7), 180);
`;
const silentChild = `process.on('message',()=>{}); process.on('disconnect',()=>process.exit(0)); setInterval(()=>{},1000);`;

async function waitUntil(condition, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) {
    if (Date.now() >= deadline) assert.fail('Timed out waiting for isolated transcription service');
    await delay(25);
  }
}
async function fixture(t, { enabled = true, childCode = responsiveChild, crashFirst = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'yuqu-asr-service-test-'));
  const paths = servicePaths({ YUQU_ASR_SERVICE_HOME: root });
  await atomicJson(paths.enabled, { enabled });
  const controller = new AbortController(), children = [];
  let task;
  const launch = options => {
    assert.equal(task, undefined, 'one supervisor per fixture');
    task = supervise({ paths, port: 0, externalSignal: controller.signal,
      heartbeatMs: 2000, stopGraceMs: 100, retryDelay: () => 40,
      workerCommand: [process.execPath, ['-e', childCode]],
      spawnChild(command, args, options) {
        const child = spawn(command, args, { ...options, env: { ...options.env,
          YUQU_TEST_CHILD_RUN: String(children.length + 1), YUQU_TEST_CRASH_FIRST: crashFirst ? '1' : '0' } });
        children.push(child);
        return child;
      }, ...options });
    void task.catch(() => {});
    return task;
  };
  t.after(async () => {
    controller.abort();
    // Only children created by this isolated fixture are eligible for cleanup.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (task) await task.catch(() => {});
    const owned = relative(tmpdir(), root);
    assert.ok(owned.startsWith('yuqu-asr-service-test-') && !owned.includes(sep) && !isAbsolute(owned));
    await rm(root, { recursive: true, force: true });
  });
  return { root, paths, controller, children, launch };
}

test('service restarts a crashed real child and never records arbitrary child output', { timeout: 15000 }, async t => {
  const f = await fixture(t, { crashFirst: true });
  const task = f.launch();
  await waitUntil(async () => {
    const state = await readJson(f.paths.state);
    return state?.phase === 'idle' && state.restarts === 1 && f.children.length === 2;
  });
  assert.equal(f.children[0].exitCode, 7);
  assert.equal((await serviceStatus(f.paths)).running, true);
  f.controller.abort(); await task;
  assert.equal(f.children.length, 2);
  assert.equal((await serviceStatus(f.paths)).running, false);
  assert.equal((await readJson(f.paths.state)).workerPid, null);
  assert.equal(await readJson(f.paths.workerPid), null);
  const log = await readFile(f.paths.log, 'utf8');
  assert.match(log, /worker_restart_scheduled/);
  assert.match(log, /"code":7/);
  for (const file of await readdir(f.root)) {
    assert.equal((await readFile(join(f.root, file), 'utf8')).includes(secret), false, file);
  }
});

test('heartbeat timeout terminates an unresponsive child and schedules recovery', { timeout: 15000 }, async t => {
  const f = await fixture(t, { childCode: silentChild });
  const task = f.launch({ heartbeatMs: 80, stopGraceMs: 80, retryDelay: () => 1000 });
  await waitUntil(async () => (await readJson(f.paths.state))?.phase === 'backoff');
  assert.equal(alive(f.children[0].pid), false);
  f.controller.abort(); await task;
  const events = (await readFile(f.paths.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(item => item.event === 'worker_stop_requested' && item.reason === 'heartbeat'));
  assert.equal(events.filter(item => item.event === 'worker_terminated').length, 1);
  assert.equal(f.children.length, 1, 'stop during backoff must prevent another child');
});

test('disabling a live service stops its child and prevents restart', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const task = f.launch();
  await waitUntil(async () => (await readJson(f.paths.state))?.phase === 'idle');
  await atomicJson(f.paths.enabled, { enabled: false });
  await task;
  assert.equal(f.children.length, 1);
  assert.equal(alive(f.children[0].pid), false);
  assert.equal((await readJson(f.paths.state)).phase, 'stopped');
  assert.equal((await serviceStatus(f.paths)).running, false);
});

test('an already disabled service starts no worker', { timeout: 10000 }, async t => {
  const f = await fixture(t, { enabled: false });
  await f.launch();
  assert.equal(f.children.length, 0);
  assert.equal((await readJson(f.paths.state)).phase, 'stopped');
});

test('stop requests require the current nonce and do not restart a stopped child', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const task = f.launch();
  await waitUntil(async () => (await readJson(f.paths.state))?.phase === 'idle');
  const initial = await readJson(f.paths.state);
  await atomicJson(f.paths.stop, { nonce: 'stale-other-instance' });
  await delay(650);
  assert.equal((await serviceStatus(f.paths)).running, true);
  assert.equal(f.children.length, 1);
  await atomicJson(f.paths.stop, { nonce: initial.nonce });
  await task;
  assert.equal(f.children.length, 1);
  assert.equal(alive(initial.workerPid), false);
});

test('duplicate mutex owner is rejected without replacing the live service identity', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const task = f.launch();
  await waitUntil(async () => (await readJson(f.paths.state))?.phase === 'idle');
  const initial = await readJson(f.paths.state);
  await assert.rejects(supervise({ paths: f.paths, port: initial.servicePort,
    spawnChild() { assert.fail('duplicate supervisor must not spawn'); } }), { code: 'EADDRINUSE' });
  const after = await readJson(f.paths.state);
  assert.equal(after.nonce, initial.nonce);
  assert.equal(after.workerPid, initial.workerPid);
  assert.equal(after.phase, 'idle');
  assert.equal((await serviceStatus(f.paths)).running, true);
  f.controller.abort(); await task;
});

test('legacy worker refusal preserves the previous state and PID file', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const previous = { kind: 'yuqu-asr-service-v1', pid: process.pid, nonce: 'old-owned-state',
    phase: 'working', workerPid: process.pid, servicePort: 0 };
  await atomicJson(f.paths.state, previous);
  await writeFile(f.paths.workerPid, String(process.pid));
  await assert.rejects(f.launch(), /ASR_UNMANAGED_WORKER_RUNNING/);
  assert.deepEqual(await readJson(f.paths.state), previous);
  assert.equal(await readFile(f.paths.workerPid, 'utf8'), String(process.pid));
  assert.equal(f.children.length, 0);
});

test('service identity rejects a live reused PID, mismatched nonce, and stopped state', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let identity = { pid: process.pid, nonce: 'different-instance' };
  const server = net.createServer(socket => socket.end(JSON.stringify(identity)));
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const state = { kind: 'yuqu-asr-service-v1', pid: process.pid, nonce: 'expected-instance',
    phase: 'idle', workerPid: null, servicePort: server.address().port };
  await atomicJson(f.paths.state, state);
  assert.equal((await serviceStatus(f.paths)).running, false);
  identity = { pid: process.pid, nonce: state.nonce };
  assert.equal((await serviceStatus(f.paths)).running, true);
  identity = { pid: process.pid + 1, nonce: state.nonce };
  assert.equal((await serviceStatus(f.paths)).running, false);
  identity = { pid: process.pid, nonce: state.nonce };
  await atomicJson(f.paths.state, { ...state, phase: 'stopped' });
  assert.equal((await serviceStatus(f.paths)).running, false);
});

test('restart delays are bounded and supervisor environment omits inherited credentials', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 100].map(restartDelay), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.deepEqual(serviceEnvironment({ Path: 'safe-path', SystemRoot: 'safe-system',
    SMTP_PASSWORD: secret, DATABASE_URL: secret, YUQU_ASR_TOKEN: secret, NODE_OPTIONS: secret }),
  { Path: 'safe-path', SystemRoot: 'safe-system' });
});
