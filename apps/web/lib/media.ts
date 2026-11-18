import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { isAbsolute, join } from 'node:path';
import { mediaFile } from '@yuqu/domain/library';
import { AppError } from '@yuqu/domain/errors';
import { database } from './server.ts';
import { currentAccount } from './api.ts';

export function byteRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new Error('Invalid range');
  const suffix = !match[1], first = Number(suffix ? match[2] : match[1]);
  const start = suffix ? Math.max(0, size - first) : first;
  const end = suffix || !match[2] ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (![first, start, end].every(Number.isSafeInteger) || (suffix && first <= 0) || start < 0 || start >= size || end < start) throw new Error('Unsatisfiable range');
  return { start, end };
}
export async function streamMedia(request: Request, id: string): Promise<Response> {
  const profile = await currentAccount(request);
  const record = await mediaFile(database(), profile, id);
  const fixture = id === 'fixture-pcm-v1';
  const directory = process.env.MEDIA_STORAGE_DIR;
  if (!fixture && (!directory || !isAbsolute(directory) || !/^[a-f0-9-]{73}\.media$/.test(record.storage_key ?? ''))) throw new AppError(503, 'MEDIA_UNAVAILABLE', '音频存储尚未配置。');
  const path = fixture ? join(process.cwd(), 'public', 'audio', 'playback-check.wav') : join(directory!, record.storage_key);
  const info = await stat(path);
  if (!info.isFile() || (!fixture && info.size !== Number(record.byte_size))) throw new AppError(503, 'MEDIA_UNAVAILABLE', '音频文件暂时不可用。');
  const headers = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Type': fixture ? 'audio/wav' : record.mime_type,
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Disposition': 'inline' };
  let range;
  try { range = byteRange(request.headers.get('range'), info.size); }
  catch { return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.size}` } }); }
  const start = range?.start ?? 0, end = range?.end ?? info.size - 1;
  const responseHeaders = { ...headers, 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) };
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers: responseHeaders });
  const stream = createReadStream(path, { start, end });
  const abort = () => { stream.destroy(); };
  let checking = false;
  // Closing a slow, already-open response releases its file handle after removal too.
  const authorization = setInterval(() => {
    if (checking || stream.destroyed) return;
    checking = true;
    void mediaFile(database(), profile, id).then(current => {
      if (current.storage_key !== record.storage_key) abort();
    }, abort).finally(() => { checking = false; });
  }, 5000);
  authorization.unref();
  if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => { clearInterval(authorization); request.signal.removeEventListener('abort', abort); });
  return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers: responseHeaders });
}
