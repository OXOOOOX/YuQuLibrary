import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RemoteTranscriptionError extends Error {
  constructor(code, { status, retryable = false } = {}) {
    super(`Remote transcription failed (${code})`);
    this.name = 'RemoteTranscriptionError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.retryable = retryable;
  }
}
const failure = (code, options) => new RemoteTranscriptionError(code, options);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function remoteSettings(env = process.env) {
  const origin = env.YUQU_ORIGIN, token = env.YUQU_ASR_WORKER_TOKEN, workerId = env.YUQU_ASR_WORKER_ID;
  try {
    const url = new URL(origin);
    if (typeof origin !== 'string' || origin !== url.origin || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
      typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token) ||
      typeof workerId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(workerId)) throw new Error();
  } catch { throw failure('ASR_CONFIG_INVALID'); }
  return Object.freeze({ origin, token, workerId });
}

export function validateRemoteTask(value) {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) ||
    typeof value.leaseId !== 'string' || !UUID.test(value.leaseId) ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !integer(value.byteSize, 1, MAX_MEDIA_BYTES) || !integer(value.durationMs, 1, MAX_DURATION_MS) ||
    !integer(value.completedMs, 0, value.durationMs) ||
    (value.completedMs !== value.durationMs && value.completedMs % 30000 !== 0) ||
    !integer(value.attempts, 1, 3) ||
    !(value.model === null || (typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 512)) ||
    (value.pipeline !== undefined && value.pipeline !== 'semantic-v3')) {
    throw failure('ASR_TASK_INVALID');
  }
  // Do not retain an arbitrary URL, path, user identity or other server fields.
  return Object.freeze({ id: value.id.toLowerCase(), leaseId: value.leaseId.toLowerCase(), sha256: value.sha256,
    byteSize: value.byteSize, durationMs: value.durationMs, completedMs: value.completedMs,
    model: value.model, attempts: value.attempts, ...(value.pipeline ? { pipeline: value.pipeline } : {}) });
}

function deadline(parent, totalMs, idleMs) {
  const controller = new AbortController();
  let idle, expired = false;
  const expire = () => { expired = true; controller.abort(); };
  const total = setTimeout(expire, totalMs); total.unref?.();
  const touch = () => {
    if (idleMs === undefined) return;
    clearTimeout(idle); idle = setTimeout(expire, idleMs); idle.unref?.();
  };
  const abort = () => controller.abort();
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  touch();
  return { signal: controller.signal, touch,
    error: () => failure(parent?.aborted ? 'ASR_ABORTED' : expired ? 'ASR_TIMEOUT' : 'ASR_ABORTED',
      { retryable: expired && !parent?.aborted }),
    dispose: () => { clearTimeout(total); clearTimeout(idle); parent?.removeEventListener('abort', abort); } };
}
function checkAbort(scope) { if (scope.signal.aborted) throw scope.error(); }
function cancelBody(response) { try { void response.body?.cancel().catch(() => {}); } catch {} }
function httpFailure(status) {
  return failure(status === 409 ? 'ASR_LEASE_LOST' : status === 401 ? 'ASR_UNAUTHORIZED' : 'ASR_HTTP_STATUS',
    { status, retryable: status >= 500 && status <= 599 });
}
function transportFailure(error, scope) {
  if (scope.signal.aborted) return scope.error();
  if (error instanceof RemoteTranscriptionError) return error;
  // Node fetch exposes redirects rejected by redirect:error through this cause.
  // Inspect it only to classify; never attach its contents to a public error.
  if (/redirect/i.test(String(error?.cause?.message || ''))) return failure('ASR_REDIRECT_REJECTED');
  return failure('ASR_NETWORK', { retryable: true });
}
async function fetchResponse(fetchImpl, url, options, scope) {
  checkAbort(scope);
  let response;
  try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: scope.signal }); }
  catch (error) { throw transportFailure(error, scope); }
  if (scope.signal.aborted) { cancelBody(response); throw scope.error(); }
  if (!response || !integer(response.status, 100, 599)) throw failure('ASR_RESPONSE_INVALID');
  if (response.redirected || (response.url && response.url !== url)) {
    cancelBody(response); throw failure('ASR_REDIRECT_REJECTED');
  }
  return response;
}
function readBlock(reader, scope) {
  checkAbort(scope);
  return new Promise((resolveRead, reject) => {
    const abort = () => {
      try { void reader.cancel().catch(() => {}); } catch {}
      reject(scope.error());
    };
    scope.signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => reader.read()).then(resolveRead, error => reject(transportFailure(error, scope)))
      .finally(() => scope.signal.removeEventListener('abort', abort));
    if (scope.signal.aborted) abort();
  });
}
async function jsonResponse(response, scope) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) {
    cancelBody(response); throw failure('ASR_RESPONSE_TOO_LARGE');
  }
  if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    cancelBody(response); throw failure('ASR_RESPONSE_INVALID');
  }
  const reader = response.body.getReader(), blocks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await readBlock(reader, scope);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) throw failure('ASR_RESPONSE_TOO_LARGE');
      blocks.push(value);
    }
    checkAbort(scope);
    try { return JSON.parse(Buffer.concat(blocks).toString('utf8')); }
    catch { throw failure('ASR_RESPONSE_INVALID'); }
  } finally {
    try { void reader.cancel().catch(() => {}); } catch {}
    reader.releaseLock();
  }
}
async function pause(ms, signal) {
  if (signal?.aborted) throw failure('ASR_ABORTED');
  await new Promise((resolvePause, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolvePause(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(failure('ASR_ABORTED')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function createRemoteClient(settings, { fetchImpl = fetch } = {}) {
  const config = remoteSettings({ YUQU_ORIGIN: settings?.origin, YUQU_ASR_WORKER_TOKEN: settings?.token,
    YUQU_ASR_WORKER_ID: settings?.workerId });
  const headers = { Authorization: `Bearer ${config.token}`, 'x-yuqu-asr-worker': config.workerId };
  async function request(path, { method = 'POST', body, signal, empty = false, retry = false } = {}) {
    for (let attempt = 1; attempt <= (retry ? 3 : 1); attempt++) {
      const scope = deadline(signal, 15000);
      try {
        const response = await fetchResponse(fetchImpl, `${config.origin}${path}`, { method,
          headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, scope);
        if (empty && response.status === 204) { cancelBody(response); return null; }
        if (response.status !== 200) { cancelBody(response); throw httpFailure(response.status); }
        return await jsonResponse(response, scope);
      } catch (error) {
        const safe = error instanceof RemoteTranscriptionError ? error : failure('ASR_RESPONSE_INVALID');
        if (!retry || !safe.retryable || attempt === 3 || signal?.aborted) throw safe;
      } finally { scope.dispose(); }
      await pause(attempt * 100, signal);
    }
  }
  async function action(taskValue, name, chunk, signal) {
    const task = validateRemoteTask(taskValue);
    const body = { leaseId: task.leaseId, ...(chunk === undefined ? {} : { chunk }) };
    const result = await request(`/api/asr/v1/jobs/${task.id}/${name}`, { body, signal, retry: true });
    if (!object(result) || result.ok !== true) throw failure('ASR_RESPONSE_INVALID');
    return true;
  }
  return Object.freeze({
    async health(signal) {
      const result = await request('/api/asr/v1/health', { method: 'GET', signal });
      if (!object(result) || result.protocolVersion !== '1.0') throw failure('ASR_PROTOCOL_UNSUPPORTED');
      return result;
    },
    async claim(signal) {
      const result = await request('/api/asr/v1/jobs/claim', { signal, empty: true });
      return result === null ? null : validateRemoteTask(result?.job);
    },
    renew: (task, signal) => action(task, 'heartbeat', undefined, signal),
    save: (task, chunk, signal) => action(task, 'chunk', chunk, signal),
    complete: (task, signal) => action(task, 'complete', undefined, signal),
    fail: (task, signal) => action(task, 'fail', undefined, signal),
    async download(taskValue, directory, signal) {
      const task = validateRemoteTask(taskValue), scope = deadline(signal, 300000, 15000);
      let file, part, owned = false, reader, response;
      try {
        if (typeof directory !== 'string' || !isAbsolute(directory) || !(await stat(directory)).isDirectory()) {
          throw failure('ASR_MEDIA_STORAGE');
        }
        const base = resolve(directory), target = join(base, `${task.id}.media`);
        part = join(base, `.${task.id}-${randomUUID()}.part`);
        response = await fetchResponse(fetchImpl, `${config.origin}/api/asr/v1/jobs/${task.id}/media`, {
          method: 'GET', headers: { ...headers, 'x-yuqu-asr-lease': task.leaseId, 'Accept-Encoding': 'identity' }
        }, scope);
        if (response.status !== 200) { cancelBody(response); throw httpFailure(response.status); }
        const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
        // Next.js may omit Content-Length on streamed route responses. The leased
        // task's byteSize, actual streamed length and SHA256 remain authoritative.
        if ((length !== null && (!/^\d+$/.test(length) || Number(length) !== task.byteSize || Number(length) > MAX_MEDIA_BYTES)) ||
          (encoding && encoding.toLowerCase() !== 'identity') || !response.body) {
          cancelBody(response); throw failure('ASR_MEDIA_LENGTH');
        }
        scope.touch();
        file = await open(part, 'wx', 0o600); owned = true;
        reader = response.body.getReader();
        const digest = createHash('sha256'); let size = 0;
        for (;;) {
          const { done, value } = await readBlock(reader, scope);
          if (done) break;
          scope.touch(); checkAbort(scope);
          size += value.byteLength;
          if (size > task.byteSize || size > MAX_MEDIA_BYTES) throw failure('ASR_MEDIA_LENGTH');
          digest.update(value);
          let offset = 0;
          while (offset < value.byteLength) {
            checkAbort(scope);
            const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
            if (!bytesWritten) throw failure('ASR_MEDIA_STORAGE');
            offset += bytesWritten;
          }
        }
        checkAbort(scope);
        if (size !== task.byteSize) throw failure('ASR_MEDIA_LENGTH');
        if (digest.digest('hex') !== task.sha256) throw failure('ASR_MEDIA_HASH');
        await file.close(); file = null;
        checkAbort(scope);
        await rename(part, target); owned = false;
        return target;
      } catch (error) {
        if (scope.signal.aborted) throw scope.error();
        throw error instanceof RemoteTranscriptionError ? error : failure('ASR_MEDIA_STORAGE');
      } finally {
        scope.dispose();
        if (reader) { try { void reader.cancel().catch(() => {}); } catch {} reader.releaseLock(); }
        else if (response) cancelBody(response);
        if (file) await file.close().catch(() => {});
        if (owned) await rm(part, { force: true }).catch(() => {});
      }
    }
  });
}
