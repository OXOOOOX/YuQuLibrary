import { fileIo as fs } from '@kit.CoreFileKit';
import { media } from '@kit.MediaKit';
import { http } from '@kit.NetworkKit';

const CHUNK_BYTES: number = 2 * 1024 * 1024;
const MAX_BYTES: number = 100 * 1024 * 1024;

// One instance belongs to one playback session. Unlinking the open file also
// lets the OS reclaim it if the process is killed between download and release.
export class PlaybackCacheDownload {
  private file?: fs.File;
  private request?: http.HttpRequest;
  private cancelled: boolean = false;

  cancel(): void {
    this.cancelled = true;
    const request = this.request;
    this.request = undefined;
    request?.destroy();
  }

  close(): void {
    this.cancel();
    if (this.file !== undefined) {
      fs.closeSync(this.file);
      this.file = undefined;
    }
  }

  async read(directory: string, url: string, token: string,
    onPercent: (percent: number) => void): Promise<media.AVFileDescriptor> {
    const path = directory + '/yuqu-listening-cache.tmp';
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.READ_WRITE);
    this.file = file;
    fs.unlinkSync(path);
    let received = 0;
    let total = 0;
    do {
      if (this.cancelled) throw new Error('已取消缓存');
      const end = Math.min(received + CHUNK_BYTES, total || MAX_BYTES) - 1;
      const request = http.createHttp();
      this.request = request;
      let response: http.HttpResponse;
      try {
        response = await request.request(url, {
          method: http.RequestMethod.GET, header: { 'Authorization': 'Bearer ' + token, 'Range': `bytes=${received}-${end}` },
          expectDataType: http.HttpDataType.ARRAY_BUFFER, usingCache: false, usingProxy: false,
          maxRedirects: 0, maxLimit: CHUNK_BYTES, connectTimeout: 10000, readTimeout: 30000
        });
      } finally {
        if (this.request === request) { this.request = undefined; request.destroy(); }
      }
      if (this.cancelled) throw new Error('已取消缓存');
      const headers = response.header as Record<string, string>;
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range'] || headers['Content-Range'] || '');
      const data = response.result;
      if (response.responseCode !== 206 || !range || !(data instanceof ArrayBuffer)) throw new Error('未收到完整音频片段');
      const size = Number(range[3]);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES || (total > 0 && total !== size) ||
        Number(range[1]) !== received || Number(range[2]) !== Math.min(end, size - 1) ||
        data.byteLength !== Number(range[2]) - received + 1 || data.byteLength <= 0) throw new Error('音频长度不符');
      total = size;
      if (await fs.write(file.fd, data) !== data.byteLength) throw new Error('本地音频未完整写入');
      received += data.byteLength;
      if (!this.cancelled) onPercent(Math.floor(received * 100 / total));
    } while (received < total);
    if (this.cancelled) throw new Error('已取消缓存');
    return { fd: file.fd, offset: 0, length: total };
  }
}
