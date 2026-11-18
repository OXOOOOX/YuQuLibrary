import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError } from './errors.ts';

const fail = (message: string) => new AppError(400, 'IMPORT_SOURCE_INVALID', message);
export function sourceUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048) throw fail('请输入有效的公开链接。');
  let url: URL; try { url = new URL(value.trim()); } catch { throw fail('请输入完整的 http 或 https 链接。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) throw fail('只支持公开网站的标准 HTTP/HTTPS 地址。');
  url.hash = '';
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
      (isIP(hostname) && !publicAddress(hostname))) throw fail('不能导入本机或内网地址。');
  return url;
}
export function publicAddress(value: string): boolean {
  try { return ipaddr.process(value).range() === 'unicast'; } catch { return false; }
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); throw signal.reason; }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function publicDns(host: string, signal: AbortSignal): Promise<{ address: string; family: number }[]> {
  // Explicit opt-in for development networks that replace DNS with proxy fake-IP ranges.
  // The resolver is fixed, TLS authenticated, bounded, and cannot be supplied by an importing user.
  const url = new URL('https://dns.google/resolve');
  url.searchParams.set('name', host); url.searchParams.set('type', 'A'); url.searchParams.set('edns_client_subnet', '0.0.0.0/0');
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = https.get(url, { signal, agent: false, family: 4, lookup: (_host, _opts, done) => done(null, '8.8.8.8', 4) }, resolve);
    req.once('error', reject);
  });
  try {
    if (response.statusCode !== 200) throw fail('公开 DNS 解析暂时不可用。');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response) { size += chunk.length; if (size > 65536) throw fail('DNS 响应过大。'); chunks.push(Buffer.from(chunk)); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.Status !== 0 || !Array.isArray(result.Answer)) throw fail('未找到可用的公开音频地址。');
    return result.Answer.filter((row: { type: number }) => row.type === 1).map((row: { data: string }) => ({ address: row.data, family: 4 }));
  } finally { response.destroy(); }
}
export type RemoteResponse = http.IncomingMessage & { sourceUrl: string };
export interface RemoteOptions { range?: { start: number; etag: string }; site?: 'bilibili'; redirect?: 'manual' }

export function bilibiliHeaders(url: URL, site?: 'bilibili'): Record<string, string> {
  if (site === undefined) return {};
  const host = url.hostname;
  const allowed = host === 'upos-hz-mirrorakam.akamaized.net' ||
    ['bilivideo.com', 'bilivideo.cn'].some(domain => host === domain || host.endsWith(`.${domain}`));
  if (site !== 'bilibili' || url.protocol !== 'https:' || !allowed) throw fail('B 站音轨跳转到不支持的来源。');
  return { Referer: 'https://www.bilibili.com/' };
}

export function decodeXml(value: string): string {
  const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, name: string) => {
    if (names[name]) return names[name];
    const number = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!Number.isInteger(number) || number <= 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) throw fail('RSS 包含无效字符。');
    return String.fromCodePoint(number);
  });
}

/** Validate all DNS answers, then pin the socket to one approved address. Every redirect repeats this check. */
export async function openRemote(value: string, signal: AbortSignal, options: RemoteOptions = {}): Promise<RemoteResponse> {
  if (options.range && (!Number.isSafeInteger(options.range.start) || options.range.start < 0 ||
      options.range.start > 100 * 1024 * 1024 || options.range.etag.length > 512 ||
      !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(options.range.etag))) throw fail('音频续传参数无效。');
  return openChecked(value, signal, options, 0);
}

async function openChecked(value: string, signal: AbortSignal, options: RemoteOptions, redirects: number): Promise<RemoteResponse> {
  signal.throwIfAborted();
  if (redirects > 5) throw fail('链接跳转次数过多。');
  const url = sourceUrl(value), host = url.hostname.replace(/^\[|\]$/g, '');
  const siteHeaders = bilibiliHeaders(url, options.site);
  const connection = new AbortController();
  let received: http.IncomingMessage | undefined;
  const abort = () => { connection.abort(signal.reason); received?.destroy(signal.reason instanceof Error ? signal.reason : undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const headerTimer = setTimeout(() => connection.abort(new AppError(400, 'REMOTE_HEADERS_TIMEOUT', '来源连接或响应超时，请稍后重试。')), 30000);
  const cleanup = () => { clearTimeout(headerTimer); signal.removeEventListener('abort', abort); };
  let response: http.IncomingMessage;
  try {
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(
      process.env.YUQU_PUBLIC_DNS === '1' ? publicDns(host, connection.signal) : lookup(host, { all: true }), connection.signal);
    connection.signal.throwIfAborted();
    if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw fail('链接指向不可导入的网络地址。');
    const selected = addresses.find(entry => entry.family === 4) ?? addresses[0];
    response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        signal: connection.signal, agent: false, family: selected.family,
        lookup: (_host, _options, done) => done(null, selected.address, selected.family),
        headers: { 'User-Agent': 'YuQuLibrary/0.1', 'Accept-Encoding': 'identity', Accept: '*/*',
          ...siteHeaders,
          ...(options.range ? { Range: `bytes=${options.range.start}-`, 'If-Range': options.range.etag } : {}) }
      }, incoming => {
        received = incoming;
        clearTimeout(headerTimer);
        incoming.once('close', cleanup);
        // The consumer attaches after this callback; retain any intervening error on the stream.
        incoming.on('error', () => {});
        resolve(incoming);
      });
      request.setTimeout(15000, () => {
        const error = new AppError(400, 'REMOTE_IDLE_TIMEOUT', '来源传输中断，请稍后重试。');
        received?.destroy(error);
        request.destroy(error);
      });
      request.once('error', error => reject(connection.signal.aborted ? connection.signal.reason : error));
    });
  } catch (error) { cleanup(); throw error; }
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    // A restricted resolver validates Location before deciding whether to make another request.
    if (options.redirect === 'manual') return Object.assign(response, { sourceUrl: url.href });
    const location = response.headers.location; response.destroy();
    if (!location) throw fail('来源跳转缺少目标地址。');
    return openChecked(new URL(location, url).href, signal, options, redirects + 1);
  }
  if (!(options.range ? [200, 206, 416] : [200]).includes(response.statusCode ?? 0)) {
    response.destroy(); throw new AppError(400, 'REMOTE_HTTP_STATUS', `来源返回 HTTP ${response.statusCode ?? 0}，请确认链接可访问。`);
  }
  if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
    response.destroy(); throw fail('来源使用了不支持的内容编码。');
  }
  return Object.assign(response, { sourceUrl: url.href });
}

export function parseFeed(xml: string, base: string): { title: string; episodes: { title: string; url: string }[] } {
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) throw fail('RSS 格式无效或超过 2 MB。');
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, parseTagValue: false, parseAttributeValue: false }).parse(xml);
  const channel = parsed.rss?.channel ?? parsed.feed;
  if (!channel) throw fail('链接不是支持的 RSS/Atom 节目源。');
  const text = (value: unknown, fallback: string) => typeof value === 'string' ? decodeXml(value).trim().slice(0, 300) || fallback : fallback;
  const items = channel.item ?? channel.entry ?? [];
  const episodes: { title: string; url: string }[] = [], seen = new Set<string>();
  for (const item of (Array.isArray(items) ? items : [items]).slice(0, 300)) {
    const links = item.link ? (Array.isArray(item.link) ? item.link : [item.link]) : [];
    const raw = item.enclosure?.['@_url'] ?? links.find((link: Record<string, unknown>) => link['@_rel'] === 'enclosure')?.['@_href'];
    if (typeof raw !== 'string') continue;
    try {
      const url = sourceUrl(new URL(decodeXml(raw), base).href).href;
      if (!seen.has(url)) { episodes.push({ url, title: text(item.title, '未命名单集') }); seen.add(url); }
    } catch { /* Invalid enclosure is omitted; it cannot reach the downloader. */ }
    if (episodes.length >= 100) break;
  }
  if (!episodes.length) throw fail('没有找到可导入的音频单集。');
  return { title: text(channel.title, '播客节目'), episodes };
}

export async function previewFeed(url: string) {
  const signal = AbortSignal.timeout(20000), response = await openRemote(url, signal);
  const chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of response) {
      size += chunk.length; if (size > 2 * 1024 * 1024) throw fail('RSS 超过 2 MB。');
      chunks.push(Buffer.from(chunk));
    }
    return parseFeed(Buffer.concat(chunks).toString('utf8'), response.sourceUrl);
  } finally { response.destroy(); }
}
