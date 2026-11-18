import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openRemote, type RemoteResponse, type RemoteOptions } from './remote.ts';
import { AppError } from './errors.ts';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_CONNECTIONS = 3;
const failures = {
  MEDIA_TOO_LARGE: [400, '音频超过当前 100 MB 上限。'],
  MEDIA_RESPONSE_INVALID: [502, '音频来源返回的内容信息不一致，请重新导入。'],
  MEDIA_RESUME_INVALID: [502, '音频来源无法安全续传，请重新导入。'],
  MEDIA_DOWNLOAD_TRUNCATED: [502, '音频下载未完成，请稍后重试。'],
  MEDIA_DOWNLOAD_INTERRUPTED: [502, '音频下载连接中断，请稍后重试。'],
  MEDIA_DOWNLOAD_FAILED: [502, '音频下载失败，请检查公开链接后重试。'],
  MEDIA_DOWNLOAD_ABORTED: [408, '音频下载已取消。'],
  MEDIA_DOWNLOAD_EMPTY: [400, '音频来源没有返回可下载的内容。'],
  MEDIA_STORAGE_WRITE_FAILED: [500, '音频文件保存失败，请稍后重试。'],
  REMOTE_IDLE_TIMEOUT: [504, '音频来源长时间没有返回数据，请稍后重试。'],
  REMOTE_HEADERS_TIMEOUT: [504, '连接音频来源超时，请稍后重试。'],
  REMOTE_HTTP_STATUS: [502, '音频来源暂时拒绝下载，请稍后重试。'],
  REMOTE_DNS_FAILED: [502, '音频来源的域名解析失败，请稍后重试。'],
  REMOTE_TLS_FAILED: [502, '音频来源的安全证书验证失败，暂时无法下载。'],
  IMPORT_SOURCE_INVALID: [400, '音频来源暂时无法下载，请检查链接是否公开有效。']
} as const;
type FailureCode = keyof typeof failures;
const failure = (code: FailureCode): AppError => new AppError(failures[code][0], code, failures[code][1]);
const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETRESET', 'ECONNREFUSED',
  'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE',
  'REMOTE_IDLE_TIMEOUT', 'REMOTE_HEADERS_TIMEOUT', 'MEDIA_DOWNLOAD_TRUNCATED']);
const tlsCodes = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED']);
const transportCodes = new Set([...transientCodes].filter(code => !code.startsWith('MEDIA_'))
  .concat(['ENOTFOUND', 'REMOTE_HTTP_STATUS', ...tlsCodes]));
function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : '';
}
function safeError(error: unknown): AppError {
  const code = codeOf(error);
  const previous = typeof error === 'object' && error !== null && 'transportCode' in error ? error.transportCode : undefined;
  const transportCode = typeof previous === 'string' && transportCodes.has(previous) ? previous : transportCodes.has(code) ? code : undefined;
  const safe = failure(code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'REMOTE_DNS_FAILED' : tlsCodes.has(code) ? 'REMOTE_TLS_FAILED' :
    Object.hasOwn(failures, code) ? code as FailureCode : transientCodes.has(code) ? 'MEDIA_DOWNLOAD_INTERRUPTED' : 'MEDIA_DOWNLOAD_FAILED');
  return transportCode ? Object.assign(safe, { transportCode }) : safe;
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw failure('MEDIA_DOWNLOAD_ABORTED');
}
function lengthHeader(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw failure('MEDIA_RESPONSE_INVALID');
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) throw failure('MEDIA_RESPONSE_INVALID');
  return length;
}
function strongEtag(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 512 && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : null;
}

export interface DownloadProgress { receivedBytes: number; expectedBytes: number | null; connections: number }
export interface DownloadResult { byteSize: number; sha256: string; connections: number }
export interface DownloadFile {
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}
export type DownloadTransport = (url: string, signal: AbortSignal,
  options?: RemoteOptions) => Promise<RemoteResponse>;
interface DownloadDependencies {
  openTransport?: DownloadTransport;
  openFile?: (path: string, flags: 'wx') => Promise<DownloadFile>;
}

/** Tests inject transport and file operations; production downloadMedia always uses openRemote. */
export function createMediaDownloader({ openTransport = openRemote, openFile = open }: DownloadDependencies = {}) {
  return async function download(url: string, path: string, signal: AbortSignal,
    onProgress?: (progress: DownloadProgress) => void, options?: Pick<RemoteOptions, 'site'>): Promise<DownloadResult> {
    checkAbort(signal);
    let file: DownloadFile;
    try { file = await openFile(path, 'wx'); } catch { throw failure('MEDIA_STORAGE_WRITE_FAILED'); }
    const digest = createHash('sha256');
    let byteSize = 0, expectedBytes: number | null = null, etag: string | null = null;
    let finalUrl: string | null = null, connections = 0, result: DownloadResult | undefined, problem: AppError | undefined;
    const progress = () => {
      try { onProgress?.({ receivedBytes: byteSize, expectedBytes, connections }); }
      catch { throw failure('MEDIA_DOWNLOAD_FAILED'); }
    };
    try {
      while (connections < MAX_CONNECTIONS) {
        checkAbort(signal);
        const resuming = byteSize > 0;
        let response: RemoteResponse | undefined;
        const abortResponse = () => { response?.destroy(); };
        try {
          connections++;
          progress();
          response = await openTransport(finalUrl ?? url, signal,
            resuming ? { ...options, range: { start: byteSize, etag: etag! } } : options);
          checkAbort(signal);
          signal.addEventListener('abort', abortResponse, { once: true });
          const contentLength = lengthHeader(response.headers['content-length']);
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw failure('MEDIA_RESPONSE_INVALID');
          if (resuming) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range'] ?? ''));
            if (response.statusCode !== 206 || response.sourceUrl !== finalUrl || strongEtag(response.headers.etag) !== etag ||
                !range || Number(range[1]) !== byteSize || Number(range[2]) !== expectedBytes! - 1 || Number(range[3]) !== expectedBytes ||
                contentLength !== expectedBytes! - byteSize) throw failure('MEDIA_RESUME_INVALID');
          } else {
            if (response.statusCode !== 200 || response.headers['content-range'] !== undefined) throw failure('MEDIA_RESPONSE_INVALID');
            if (contentLength !== null && contentLength > MAX_BYTES) throw failure('MEDIA_TOO_LARGE');
            expectedBytes = contentLength;
            etag = strongEtag(response.headers.etag);
            finalUrl = response.sourceUrl;
          }
          progress();
          for await (const raw of response) {
            checkAbort(signal);
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            if (chunk.length > MAX_BYTES - byteSize) throw failure('MEDIA_TOO_LARGE');
            if (expectedBytes !== null && chunk.length > expectedBytes - byteSize) throw failure('MEDIA_RESPONSE_INVALID');
            let written = 0;
            while (written < chunk.length) {
              checkAbort(signal);
              try {
                const { bytesWritten } = await file.write(chunk, written, chunk.length - written, byteSize + written);
                if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.length - written) throw failure('MEDIA_STORAGE_WRITE_FAILED');
                written += bytesWritten;
              } catch { throw failure('MEDIA_STORAGE_WRITE_FAILED'); }
            }
            // Only complete disk writes advance the offset or digest used by a new request.
            byteSize += chunk.length;
            digest.update(chunk);
            progress();
          }
          checkAbort(signal);
          if (expectedBytes !== null && byteSize !== expectedBytes) throw failure('MEDIA_DOWNLOAD_TRUNCATED');
          if (byteSize === 0) throw failure('MEDIA_DOWNLOAD_EMPTY');
          result = { byteSize, sha256: digest.digest('hex'), connections };
          break;
        } catch (error) {
          checkAbort(signal);
          if (connections < MAX_CONNECTIONS && byteSize > 0 && expectedBytes !== null && byteSize < expectedBytes && etag !== null &&
              transientCodes.has(codeOf(error))) continue;
          throw safeError(error);
        } finally {
          signal.removeEventListener('abort', abortResponse);
          response?.destroy();
        }
      }
    } catch (error) { problem = safeError(error); }
    finally {
      try { await file.close(); } catch { problem ??= failure('MEDIA_STORAGE_WRITE_FAILED'); }
    }
    if (problem) throw problem;
    checkAbort(signal);
    if (!result) throw failure('MEDIA_DOWNLOAD_FAILED');
    return result;
  };
}

const defaultDownloader = createMediaDownloader();
export async function downloadMedia(url: string, path: string, signal: AbortSignal,
  onProgress?: (progress: DownloadProgress) => void, options?: Pick<RemoteOptions, 'site'>): Promise<DownloadResult> {
  return defaultDownloader(url, path, signal, onProgress, options);
}
