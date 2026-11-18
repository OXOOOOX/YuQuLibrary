import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';

export interface StreamEvent {
  event: string;
  data: string;
  id: string;
}

export interface StreamState {
  status: string;
  reconnects: number;
  cursor: string;
  error: string;
}

/** Per-connection parser. Incomplete messages are discarded when reconnecting. */
class StreamDecoder {
  private decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
  private buffer: string = '';
  private event: string = 'message';
  private data: string[] = [];
  private dataSize: number = 0;
  private lastId: string;
  private skipLeadingLf: boolean = false;
  retryMs: number = 1000;

  constructor(cursor: string) { this.lastId = cursor; }

  push(chunk: ArrayBuffer): StreamEvent[] {
    this.buffer += this.decoder.decodeToString(new Uint8Array(chunk), { stream: true });
    if (this.skipLeadingLf && this.buffer.length > 0) {
      if (this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1);
      this.skipLeadingLf = false;
    }
    const output: StreamEvent[] = [];
    while (true) {
      const end: number = this.buffer.search(/[\r\n]/);
      if (end < 0) break;
      if (end > 65536) throw new Error('事件行超过 64 KiB');
      const line: string = this.buffer.slice(0, end);
      const skip: number = this.buffer[end] === '\r' && this.buffer[end + 1] === '\n' ? 2 : 1;
      this.skipLeadingLf = this.buffer[end] === '\r' && end === this.buffer.length - 1;
      this.buffer = this.buffer.slice(end + skip);
      if (line === '') {
        if (this.data.length > 0) {
          output.push({ event: this.event, data: this.data.join('\n'), id: this.lastId });
        }
        this.event = 'message';
        this.data = [];
        this.dataSize = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon: number = line.indexOf(':');
      const field: string = colon < 0 ? line : line.slice(0, colon);
      let value: string = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value || 'message';
      if (field === 'data') {
        this.dataSize += value.length + (this.data.length > 0 ? 1 : 0);
        if (this.dataSize > 65536) throw new Error('事件超过 64 KiB');
        this.data.push(value);
      }
      if (field === 'id' && !value.includes('\0')) this.lastId = value;
      if (field === 'retry' && /^[0-9]+$/.test(value)) {
        const delay: number = Number(value);
        if (Number.isFinite(delay)) this.retryMs = Math.max(250, Math.min(30000, delay));
      }
    }
    if (this.buffer.length > 65536) throw new Error('事件行超过 64 KiB');
    return output;
  }
}

/** Native SSE transport: one request, one retry timer, and an explicit lifecycle. */
export class EventStream {
  private onEvent: (event: StreamEvent) => void;
  private onState: (state: StreamState) => void;
  private request: http.HttpRequest | undefined = undefined;
  private retryTimer: number = -1;
  private idleTimer: number = -1;
  private generation: number = 0;
  private requested: boolean = false;
  private foreground: boolean = true;
  private url: string = '';
  private token: string = '';
  private cursor: string = '';
  private reconnects: number = 0;
  private attempts: number = 0;
  private failures: number = 0;
  private retryMs: number = 1000;

  constructor(onEvent: (event: StreamEvent) => void, onState: (state: StreamState) => void) {
    this.onEvent = onEvent;
    this.onState = onState;
  }

  start(url: string, token: string = ''): void {
    this.stop();
    this.url = url;
    this.token = token;
    this.cursor = '';
    this.reconnects = 0;
    this.attempts = 0;
    this.failures = 0;
    this.retryMs = 1000;
    this.requested = true;
    if (this.foreground) this.connect();
    else this.publish('paused', '');
  }

  stop(): void {
    this.requested = false;
    this.cancelAttempt();
    this.token = '';
    this.publish('stopped', '');
  }

  setForeground(foreground: boolean): void {
    if (foreground === this.foreground) return;
    this.foreground = foreground;
    if (!this.requested) return;
    this.cancelAttempt();
    if (foreground) this.connect();
    else this.publish('paused', '');
  }

  reconnect(): void {
    if (!this.requested || !this.foreground) return;
    this.cancelAttempt();
    this.publish('retrying', '主动断开，正在恢复事件');
    this.schedule(1000);
  }

  private connect(): void {
    if (!this.requested || !this.foreground) return;
    const generation: number = ++this.generation;
    if (this.attempts > 0) this.reconnects++;
    this.attempts++;
    this.publish('connecting', '');
    const request: http.HttpRequest = http.createHttp();
    this.request = request;
    const decoder: StreamDecoder = new StreamDecoder(this.cursor);
    let finished: boolean = false;
    let validStream: boolean = false;
    let pendingChunks: ArrayBuffer[] = [];
    let pendingBytes: number = 0;
    const live = (): boolean => !finished && this.requested && this.foreground && generation === this.generation;
    const finish = (error: string, terminal: boolean = false, healthy: boolean = false): void => {
      if (!live()) return;
      finished = true;
      this.cancelAttempt();
      if (terminal) {
        this.requested = false;
        this.publish('error', error);
        return;
      }
      this.publish('retrying', error);
      if (healthy) this.failures = 0;
      const delay: number = Math.min(30000, this.retryMs * Math.pow(2, Math.min(5, this.failures)));
      if (!healthy) this.failures++;
      this.schedule(delay);
    };
    const watch = (): void => {
      if (this.idleTimer >= 0) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { finish('连接无响应，正在恢复'); }, 30000);
    };
    const consume = (chunk: ArrayBuffer): void => {
      if (!live()) return;
      try {
        const events: StreamEvent[] = decoder.push(chunk);
        this.retryMs = decoder.retryMs;
        for (const event of events) {
          if (!live()) break;
          this.onEvent(event);
          if (!live()) break;
          this.cursor = event.id;
          this.failures = 0;
          this.publish('connected', '');
        }
      } catch (error) {
        finish((error as Error).message);
      }
    };
    request.on('headersReceive', (headers: Object) => {
      if (!live()) return;
      const values = headers as Record<string, string>;
      const type: string = values['content-type'] || values['Content-Type'] || '';
      const statusLine: string = values['status-line'] || '';
      const status: number = Number(statusLine.split(' ')[1] || '0');
      if (status === 401 || status === 403) {
        finish('登录状态已失效，请重新登录', true);
        return;
      }
      if ((status !== 0 && status !== 200) || !type.toLowerCase().startsWith('text/event-stream')) {
        // Some SDK versions omit status-line. The request promise owns completion
        // so a JSON 401 cannot be mistaken for a retryable transport disconnect.
        return;
      }
      validStream = true;
      this.publish('connected', '');
      watch();
      // Native callback queues can deliver body bytes before headersReceive.
      // Hold them until the response type has been checked instead of losing replay.
      for (const chunk of pendingChunks) consume(chunk);
      pendingChunks = [];
      pendingBytes = 0;
    });
    request.on('dataReceive', (chunk: ArrayBuffer) => {
      if (!live()) return;
      watch();
      if (!validStream) {
        pendingBytes += chunk.byteLength;
        if (pendingBytes > 65536) { finish('响应头之前的数据过大'); return; }
        pendingChunks.push(chunk);
        return;
      }
      consume(chunk);
    });
    request.on('dataEnd', () => { if (live()) watch(); });
    const headers: Record<string, string> = { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' };
    if (this.cursor.length > 0) headers['Last-Event-ID'] = this.cursor;
    if (this.token.length > 0) headers['Authorization'] = `Bearer ${this.token}`;
    watch();
    try {
      request.requestInStream(this.url, {
        method: http.RequestMethod.GET, header: headers, usingCache: false,
        connectTimeout: 10000, readTimeout: 0, usingProxy: false, maxRedirects: 0
      }).then((status: number) => {
        finish(status === 200 && validStream ? '' : `事件请求失败（${status}）`, status === 401 || status === 403, status === 200 && validStream);
      }).catch((error: Error) => { finish(error.message); });
    } catch (error) {
      finish((error as Error).message);
    }
  }

  private schedule(delay: number): void {
    const generation: number = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = -1;
      if (generation === this.generation) this.connect();
    }, delay);
  }

  private cancelAttempt(): void {
    this.generation++;
    if (this.retryTimer >= 0) clearTimeout(this.retryTimer);
    if (this.idleTimer >= 0) clearTimeout(this.idleTimer);
    this.retryTimer = -1;
    this.idleTimer = -1;
    const request: http.HttpRequest | undefined = this.request;
    this.request = undefined;
    if (request !== undefined) {
      request.off('headersReceive');
      request.off('dataReceive');
      request.off('dataEnd');
      request.destroy();
    }
  }

  private publish(status: string, error: string): void {
    this.onState({ status: status, reconnects: this.reconnects, cursor: this.cursor, error: error });
  }
}
