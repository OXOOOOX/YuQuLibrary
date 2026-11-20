import { AppError } from './errors.ts';
import { openRemote, sourceUrl, type RemoteResponse, type RemoteOptions } from './remote.ts';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const MAX_PAGES = 100;
const fail = (code: string, message: string) => new AppError(400, code, message);
type JsonObject = Record<string, unknown>;
type Transport = (url: string, signal: AbortSignal, options?: RemoteOptions) => Promise<RemoteResponse>;
interface Page { page: number; cid: number; title: string; durationMs: number }
interface Video { title: string; bvid: string; pages: Page[] }
export interface BilibiliSource { bvid: string; page: number; url: string; explicitPage: boolean }
export interface BilibiliAudio {
  audioUrl: string; title: string; bvid: string; cid: number; page: number; durationMs: number;
}
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function enabled(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== '0';
}
function responseError(): AppError {
  return fail('BILIBILI_RESPONSE_INVALID', 'B 站返回的内容不完整，请稍后重试。');
}
function restricted(): AppError {
  return fail('BILIBILI_SOURCE_RESTRICTED', '暂只支持无需登录、无需付费即可完整播放的 B 站普通视频。');
}
function canonical(bvid: string, page: number): string {
  return `https://www.bilibili.com/video/${bvid}?p=${page}`;
}

/** Detection only. A matching site must still pass the strict parser below. */
export function isBilibiliUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv' || host.endsWith('.b23.tv');
  } catch { return false; }
}

export function parseBilibiliUrl(value: string): BilibiliSource {
  let url: URL;
  try { url = new URL(value); } catch { throw fail('BILIBILI_URL_INVALID', '请输入完整的 B 站 BV 视频链接。'); }
  if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw fail('BILIBILI_URL_INVALID', '请使用不含账号信息的 HTTPS B 站 BV 视频链接。');
  }
  const match = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname);
  if (!['www.bilibili.com', 'bilibili.com'].includes(url.hostname) || !match) {
    throw fail('BILIBILI_URL_INVALID', '暂只支持 bilibili.com/video/BV 开头的普通视频链接。');
  }
  const page = pageNumber(url);
  return { bvid: match[1], page: page ?? 1, url: canonical(match[1], page ?? 1), explicitPage: page !== undefined };
}

function pageNumber(url: URL): number | undefined {
  const pages = url.searchParams.getAll('p');
  if (pages.length > 1 || (pages.length === 1 && !/^[1-9][0-9]*$/.test(pages[0]))) {
    throw fail('BILIBILI_URL_INVALID', '分 P 编号必须是正整数。');
  }
  if (!pages.length) return undefined;
  const page = Number(pages[0]);
  if (!Number.isSafeInteger(page)) throw fail('BILIBILI_URL_INVALID', '分 P 编号无效。');
  return page;
}

export function isBilibiliShortUrl(value: string): boolean {
  try { return new URL(value).hostname === 'b23.tv'; } catch { return false; }
}

function shortUrl(value: string): URL {
  const url = sourceUrl(value);
  if (url.protocol !== 'https:' || url.hostname !== 'b23.tv' || url.port ||
      !/^\/[A-Za-z0-9]{1,64}\/?$/.test(url.pathname)) {
    throw fail('BILIBILI_URL_INVALID', '请使用 HTTPS 的 b23.tv 短链接或完整 BV 视频链接。');
  }
  pageNumber(url);
  return url;
}

/** Returned API URLs are still untrusted; the downloader must also pin public DNS on every redirect. */
export function validateBilibiliAudioUrl(value: unknown): string {
  const url = sourceUrl(value);
  const host = url.hostname;
  const allowed = host === 'upos-hz-mirrorakam.akamaized.net' ||
    ['bilivideo.com', 'bilivideo.cn'].some(domain => host === domain || host.endsWith(`.${domain}`));
  if (url.protocol !== 'https:' || !allowed) {
    throw fail('BILIBILI_AUDIO_UNAVAILABLE', 'B 站暂未提供可用的公开音轨，请稍后重试。');
  }
  return url.href;
}

function parseVideo(value: unknown, bvid: string): Video {
  const envelope = object(value);
  if (!envelope || envelope.code !== 0) {
    if (envelope && [-101, -403, -10403].includes(Number(envelope.code))) throw restricted();
    throw fail('BILIBILI_SOURCE_UNAVAILABLE', '该 B 站视频暂不可访问，可能已删除、受限或请求过于频繁。');
  }
  const data = object(envelope.data);
  const rights = object(data?.rights);
  if (!data || !rights || data.bvid !== bvid || typeof data.title !== 'string' || !data.title.trim() || !Array.isArray(data.pages)) {
    throw responseError();
  }
  const entitlementFlags = ['pay', 'ugc_pay', 'ugc_pay_preview', 'arc_pay', 'movie'];
  if (entitlementFlags.some(key => rights[key] === undefined || rights[key] === null) ||
      (typeof data.is_upower_exclusive !== 'boolean' && data.is_upower_exclusive !== 0 && data.is_upower_exclusive !== 1)) {
    throw responseError();
  }
  if (enabled(data.is_upower_exclusive) || enabled(data.need_login) || enabled(data.is_preview) ||
      entitlementFlags.some(key => enabled(rights[key])) ||
      (typeof data.redirect_url === 'string' && data.redirect_url.length > 0)) throw restricted();
  if (enabled(rights.is_stein_gate)) {
    throw fail('BILIBILI_SOURCE_UNSUPPORTED', '暂不支持互动视频，请选择普通 BV 视频。');
  }
  if (data.state !== undefined && data.state !== 0) throw restricted();
  const pageNumbers = new Set<number>();
  const pages = data.pages.slice(0, MAX_PAGES).map(raw => {
    const page = object(raw);
    if (!page || !positive(page.page) || !positive(page.cid) || !positive(page.duration) || pageNumbers.has(page.page)) {
      throw responseError();
    }
    pageNumbers.add(page.page);
    return {
      page: page.page, cid: page.cid,
      title: typeof page.part === 'string' ? page.part.trim().slice(0, 300) : '',
      durationMs: page.duration * 1000
    };
  });
  if (!pages.length) throw responseError();
  return { title: data.title.trim().slice(0, 300), bvid, pages };
}

function pageTitle(video: Video, page: Page): string {
  return video.pages.length > 1 ? `${video.title} · P${page.page}${page.title ? ` ${page.title}` : ''}`.slice(0, 300) : video.title;
}
function selectPage(video: Video, source: BilibiliSource): Page {
  const page = video.pages.find(item => item.page === source.page);
  if (!page) throw fail('BILIBILI_PAGE_UNAVAILABLE', '该分 P 不存在，当前最多支持前 100 个分 P。');
  if (page.durationMs > MAX_DURATION_MS) throw fail('IMPORT_DURATION_EXCEEDED', '单集内容暂不能超过 4 小时。');
  return page;
}

function parseAudio(value: unknown, video: Video, page: Page): BilibiliAudio {
  const envelope = object(value);
  if (!envelope || envelope.code !== 0) {
    if (envelope && [-101, -403, -10403].includes(Number(envelope.code))) throw restricted();
    throw fail('BILIBILI_AUDIO_UNAVAILABLE', 'B 站暂未提供可用的公开音轨，请稍后重试。');
  }
  const data = object(envelope.data);
  if (!data) throw responseError();
  if (['is_preview', 'isPreview', 'need_login', 'need_vip', 'is_upower_exclusive'].some(key => enabled(data[key])) ||
      (Array.isArray(data.accept_description) && data.accept_description.some(item => typeof item === 'string' && /试看/.test(item)))) {
    throw restricted();
  }
  if (!positive(data.timelength) || data.timelength > MAX_DURATION_MS) throw responseError();
  const durationMs = data.timelength;
  // Metadata rounds to seconds. A materially shorter stream must never be stored as a full episode.
  if (Math.abs(durationMs - page.durationMs) > Math.max(2500, page.durationMs * 0.01)) throw restricted();
  const dash = object(data.dash);
  const tracks = (Array.isArray(dash?.audio) ? dash.audio : []).map(object).filter((track): track is JsonObject =>
    track !== undefined && String(track.mimeType ?? track.mime_type).toLowerCase() === 'audio/mp4' &&
    typeof track.codecs === 'string' && /^mp4a(?:\.|$)/i.test(track.codecs));
  if (!tracks.length) throw fail('BILIBILI_AAC_UNAVAILABLE', 'B 站此次未提供可单独导入的 AAC 音轨。');

  const withinLimit = tracks.flatMap(track => {
    const bandwidth = track.bandwidth;
    // Leave a little room for the MP4 container; actual bytes remain bounded by the downloader.
    if (!positive(bandwidth) || durationMs / 1000 * bandwidth / 8 * 1.05 > MAX_MEDIA_BYTES) return [];
    return [{ track, bandwidth }];
  });
  if (!withinLimit.length) {
    if (tracks.some(track => !positive(track.bandwidth))) {
      throw fail('BILIBILI_AUDIO_BITRATE_UNKNOWN', 'B 站返回的音轨码率信息不完整，无法确认音频大小，请稍后重试。');
    }
    throw fail('BILIBILI_AUDIO_TOO_LARGE', '该分 P 的所有独立 AAC 音轨预计都超过 100 MiB。');
  }

  const candidates = withinLimit.flatMap(({ track, bandwidth }) => {
    const backups = [track.backupUrl, track.backup_url].flat();
    for (const address of [track.baseUrl, track.base_url, track.url, ...backups]) {
      if (typeof address !== 'string') continue;
      try { return [{ url: validateBilibiliAudioUrl(address), bandwidth }]; }
      catch { /* Another CDN address for this track may be usable. */ }
    }
    return [];
  });
  if (!candidates.length) throw fail('BILIBILI_AUDIO_URL_UNAVAILABLE', 'B 站返回的独立 AAC 音轨暂时没有可用的下载地址，请稍后重试。');
  const moderate = candidates.filter(item => item.bandwidth <= 160_000).sort((a, b) => b.bandwidth - a.bandwidth);
  const selected = moderate[0] ?? candidates.sort((a, b) => a.bandwidth - b.bandwidth)[0];
  return { audioUrl: selected.url, title: pageTitle(video, page), bvid: video.bvid, cid: page.cid, page: page.page, durationMs };
}

export function createBilibiliProvider(options: { openTransport?: Transport } = {}) {
  const transport = options.openTransport ?? openRemote;
  async function resolveBilibiliSource(value: string, signal: AbortSignal): Promise<BilibiliSource> {
    signal.throwIfAborted();
    if (!isBilibiliShortUrl(value)) return parseBilibiliUrl(value);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    let current = shortUrl(value), requestedPage: number | undefined;
    const visited = new Set<string>();
    for (let hop = 0; hop < 5; hop++) {
      bounded.throwIfAborted();
      if (visited.has(current.href)) throw fail('BILIBILI_SHORT_URL_INVALID', 'B 站短链接出现循环跳转。');
      visited.add(current.href);
      const page = pageNumber(current);
      if (page !== undefined) {
        if (requestedPage !== undefined && page !== requestedPage) throw fail('BILIBILI_URL_INVALID', '短链接的分 P 编号与跳转目标不一致。');
        requestedPage = page;
      }
      const response = await transport(current.href, bounded, { redirect: 'manual' });
      let target: string;
      try {
        bounded.throwIfAborted();
        if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0) || !response.headers.location) {
          throw fail('BILIBILI_SHORT_URL_INVALID', '该 B 站短链接没有返回可用的视频地址，请检查链接。');
        }
        try { target = new URL(response.headers.location, current).href; }
        catch { throw fail('BILIBILI_SHORT_URL_INVALID', 'B 站短链接的跳转地址无效。'); }
      } finally { response.destroy(); }
      if (isBilibiliShortUrl(target)) { current = shortUrl(target); continue; }
      // Validate the destination before any connection; never fetch an arbitrary redirect or the BV HTML page.
      const source = parseBilibiliUrl(target);
      if (requestedPage !== undefined && source.explicitPage && source.page !== requestedPage) {
        throw fail('BILIBILI_URL_INVALID', '短链接的分 P 编号与跳转目标不一致。');
      }
      const finalPage = requestedPage ?? source.page;
      return { ...source, page: finalPage, url: canonical(source.bvid, finalPage), explicitPage: requestedPage !== undefined || source.explicitPage };
    }
    throw fail('BILIBILI_SHORT_URL_INVALID', 'B 站短链接跳转次数过多。');
  }
  async function requestJson(path: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const url = `https://api.bilibili.com${path}?${new URLSearchParams(query)}`;
    const response = await transport(url, signal);
    const abort = () => response.destroy(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) throw responseError();
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_JSON_BYTES) throw responseError();
        chunks.push(buffer);
      }
      signal.throwIfAborted();
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw responseError(); }
    } finally { signal.removeEventListener('abort', abort); response.destroy(); }
  }
  async function view(source: BilibiliSource, signal: AbortSignal): Promise<Video> {
    return parseVideo(await requestJson('/x/web-interface/view', { bvid: source.bvid }, signal), source.bvid);
  }
  return {
    resolveBilibiliSource,
    async previewBilibili(value: string, signal: AbortSignal): Promise<{ title: string; episodes: { url: string; title: string }[] }> {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const source = await resolveBilibiliSource(value, bounded);
      const video = await view(source, bounded);
      if (source.explicitPage) selectPage(video, source);
      const episodes = video.pages.filter(page => page.durationMs <= MAX_DURATION_MS)
        .map(page => ({ url: canonical(video.bvid, page.page), title: pageTitle(video, page) }));
      if (!episodes.length) throw fail('IMPORT_DURATION_EXCEEDED', '单集内容暂不能超过 4 小时。');
      return { title: video.title, episodes };
    },
    async resolveBilibiliAudio(value: string, signal: AbortSignal): Promise<BilibiliAudio> {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const source = await resolveBilibiliSource(value, bounded);
      const video = await view(source, bounded);
      const page = selectPage(video, source);
      const audio = await requestJson('/x/player/playurl', {
        bvid: source.bvid, cid: String(page.cid), fnval: '4048', fnver: '0', fourk: '0'
      }, bounded);
      return parseAudio(audio, video, page);
    }
  };
}

const provider = createBilibiliProvider();
export const previewBilibili = provider.previewBilibili;
export const resolveBilibiliAudio = provider.resolveBilibiliAudio;
export const resolveBilibiliSource = provider.resolveBilibiliSource;
