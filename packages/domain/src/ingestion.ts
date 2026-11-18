import { mkdir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseFile } from 'music-metadata';
import type { Pool } from 'pg';
import { downloadMedia } from './download.ts';
import { claimImport, renewImport, completeImport, failImport } from './library.ts';
import { AppError } from './errors.ts';
import { isBilibiliUrl, resolveBilibiliAudio, parseBilibiliUrl } from './bilibili.ts';

export function storageDirectory(): string {
  const path = process.env.MEDIA_STORAGE_DIR;
  if (!path || !isAbsolute(path)) throw new Error('MEDIA_STORAGE_DIR must be an absolute directory');
  return path;
}
export function importedMime(format: { container?: string; hasAudio?: boolean; hasVideo?: boolean }): string {
  const container = format.container ?? '';
  if (/^(MPEG|ADTS)$/.test(container)) return container === 'ADTS' ? 'audio/aac' : 'audio/mpeg';
  if (/^(WAVE|WAV)$/i.test(container)) return 'audio/wav';
  const mp4 = container.split('/').some(brand => /^(M4A|MP4|isom|iso5|iso6|mp41|mp42|QuickTime)$/i.test(brand.trim()));
  return mp4 && format.hasAudio === true && format.hasVideo === false ? 'audio/mp4' : '';
}
export function importFailure(error: unknown, phase: string, signal: AbortSignal): string {
  if (signal.aborted && signal.reason instanceof AppError) return signal.reason.message;
  if (error instanceof AppError) return error.message;
  if (phase === 'storage') return '音频存储暂时不可写，请检查存储配置后重试。';
  if (phase === 'metadata') return '音频格式或时长解析失败，请更换音频链接。';
  if (phase === 'publish') return '音频保存结果暂时无法确认，请刷新任务状态。';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析音频来源地址，请稍后重试。';
  if (code === 'ECONNRESET' || code === 'EPIPE') return '来源传输中断，当前音频未完整下载，请重试。';
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED') return '无法连接音频来源，请稍后重试。';
  return '音频下载失败，请检查公开链接后重试。';
}
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'UNKNOWN';
}
export async function ingestOne(pool: Pool): Promise<boolean> {
  const directory = storageDirectory(), item = await claimImport(pool);
  if (!item) return false;
  const storageKey = `${item.id}-${item.leaseId}.media`, path = join(directory, storageKey), partial = `${path}.part`;
  const started = Date.now();
  let phase = 'storage', receivedBytes = 0, expectedBytes: number | null = null, connections = 0;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(
    new AppError(408, 'DOWNLOAD_DEADLINE', '音频下载超过 5 分钟，请稍后重试。')), 300000);
  let renewing = false, committed = false, publicationUncertain = false;
  const heartbeat = setInterval(() => {
    if (renewing) return; renewing = true;
    void renewImport(pool, item).then(ok => {
      if (!ok) controller.abort(new AppError(409, 'IMPORT_LEASE_LOST', '下载任务已由其他进程接管，请刷新状态。'));
    }, () => controller.abort(new AppError(503, 'IMPORT_LEASE_CHECK_FAILED', '下载任务连接中断，请稍后重试。'))).finally(() => { renewing = false; });
  }, 15000);
  console.info(JSON.stringify({ event: 'ingestion_started', jobId: item.id }));
  try {
    await mkdir(directory, { recursive: true });
    phase = 'resolve';
    const video = isBilibiliUrl(item.sourceUrl) ? await resolveBilibiliAudio(item.sourceUrl, controller.signal) : null;
    phase = 'download';
    const downloaded = await downloadMedia(video?.audioUrl ?? item.sourceUrl, partial, controller.signal, progress => {
      receivedBytes = progress.receivedBytes; expectedBytes = progress.expectedBytes;
      if (connections !== progress.connections) console.info(JSON.stringify({ event: 'ingestion_connection', jobId: item.id,
        connection: progress.connections, receivedBytes, expectedBytes }));
      connections = progress.connections;
    }, video ? { site: 'bilibili' } : undefined);
    phase = 'metadata';
    const metadata = await parseFile(partial, { duration: true, skipCovers: true });
    controller.signal.throwIfAborted();
    const durationMs = Math.round((metadata.format.duration ?? 0) * 1000);
    const mimeType = importedMime(metadata.format);
    if (!mimeType || !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 4 * 3600000) throw new AppError(400, 'MEDIA_UNSUPPORTED', '暂支持可识别时长的 MP3、M4A、AAC、WAV，单集最长 4 小时。');
    if (video && Math.abs(durationMs - video.durationMs) > 2500) throw new AppError(400, 'BILIBILI_DURATION_MISMATCH', 'B 站音轨时长与所选分 P 不一致，未保存该内容。');
    phase = 'storage';
    await rename(partial, path);
    phase = 'publish';
    publicationUncertain = true;
    committed = await completeImport(pool, item, { storageKey, byteSize: downloaded.byteSize, durationMs, mimeType, sha256: downloaded.sha256,
      ...(video ? { source: { kind: 'bilibili' as const, url: parseBilibiliUrl(item.sourceUrl).url, title: video.title, bvid: video.bvid, cid: video.cid, page: video.page } } : {}) });
    publicationUncertain = false;
    console.info(JSON.stringify({ event: committed ? 'ingestion_ready' : 'ingestion_superseded', jobId: item.id,
      elapsedMs: Date.now() - started, receivedBytes, expectedBytes, connections, durationMs }));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'ingestion_failed', jobId: item.id, phase, elapsedMs: Date.now() - started,
      receivedBytes, expectedBytes, connections, errorCode: errorCode(error),
      transportCode: errorCode({ code: (error as { transportCode?: string } | undefined)?.transportCode }),
      abortReason: controller.signal.aborted ? errorCode(controller.signal.reason) : null, publicationUncertain }));
    await failImport(pool, item, importFailure(error, phase, controller.signal)).catch(() => {});
  } finally {
    clearInterval(heartbeat); clearTimeout(timer);
    await unlink(partial).catch(() => {});
    // A lost COMMIT response must never delete a file that may already be referenced.
    if (!committed && !publicationUncertain) await unlink(path).catch(() => {});
  }
  return true;
}
