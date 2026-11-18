import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { AppError } from '@yuqu/domain/errors';
import { leasedTranscript } from '@yuqu/domain/transcripts';
import { database } from './server.ts';

export function asrWorker(request: Request): void {
  const token = process.env.YUQU_ASR_WORKER_TOKEN, worker = process.env.YUQU_ASR_WORKER_ID;
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token) || !worker || !/^[A-Za-z0-9_-]{1,80}$/.test(worker)) {
    throw new AppError(503, 'ASR_NOT_CONFIGURED', '转写工作进程尚未配置。');
  }
  const supplied = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1] ?? '';
  if (supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)) ||
    request.headers.get('x-yuqu-asr-worker') !== worker) throw new AppError(401, 'ASR_UNAUTHENTICATED', '转写身份无效。');
}

export async function streamAsrMedia(request: Request, id: string): Promise<Response> {
  asrWorker(request);
  const lease = request.headers.get('x-yuqu-asr-lease');
  const task = await leasedTranscript(database(), id, lease);
  const directory = process.env.MEDIA_STORAGE_DIR;
  if (!directory || !isAbsolute(directory) || !/^[a-f0-9-]{73}\.media$/.test(task.storageKey)) {
    throw new AppError(503, 'MEDIA_UNAVAILABLE', '音频存储尚未配置。');
  }
  const base = await realpath(directory), path = await realpath(join(base, task.storageKey));
  const info = await stat(path);
  if (dirname(path) !== base || !info.isFile() || info.size !== task.byteSize || info.size <= 0 || info.size > 100 * 1024 * 1024) {
    throw new AppError(503, 'MEDIA_UNAVAILABLE', '音频文件暂时不可用。');
  }
  const stream = createReadStream(path);
  const stop = () => stream.destroy();
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void leasedTranscript(database(), id, lease).catch(stop).finally(() => { checking = false; });
  }, 15000);
  stream.once('close', () => { clearInterval(timer); request.signal.removeEventListener('abort', stop); });
  if (request.signal.aborted) stop(); else request.signal.addEventListener('abort', stop, { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(info.size),
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  } });
}
