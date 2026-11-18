import { hilog } from '@kit.PerformanceAnalysisKit';
import { EventStream, StreamEvent, StreamState } from './EventStream';

interface ProbePayload {
  version: number;
  sequence: number;
  serverTime: string;
  message: string;
}

export interface ProbeViewState {
  requested: boolean;
  status: string;
  received: number;
  lastSequence: number;
  duplicates: number;
  gaps: number;
  reconnects: number;
  resets: number;
  message: string;
  error: string;
}

type ProbeListener = (state: ProbeViewState) => void;

export class ConnectionProbe {
  private static readonly instance: ConnectionProbe = new ConnectionProbe();
  private listeners: ProbeListener[] = [];
  private stream: EventStream;
  private baseline: number = 0;
  private state: ProbeViewState = {
    requested: false, status: '未连接', received: 0, lastSequence: 0,
    duplicates: 0, gaps: 0, reconnects: 0, resets: 0, message: '', error: ''
  };

  private constructor() {
    this.stream = new EventStream((event: StreamEvent) => { this.receive(event); },
      (state: StreamState) => { this.updateStream(state); });
  }

  static getInstance(): ConnectionProbe { return ConnectionProbe.instance; }

  getSnapshot(): ProbeViewState {
    return {
      requested: this.state.requested, status: this.state.status, received: this.state.received,
      lastSequence: this.state.lastSequence, duplicates: this.state.duplicates,
      gaps: this.state.gaps, reconnects: this.state.reconnects, resets: this.state.resets,
      message: this.state.message, error: this.state.error
    };
  }

  subscribe(listener: ProbeListener): () => void {
    this.listeners.push(listener);
    listener(this.getSnapshot());
    return () => {
      const index: number = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  connect(baseUrl: string): void {
    const base: string = baseUrl.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^\s/?#]+(?::[0-9]+)?$/.test(base) &&
      !/^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/.test(base)) {
      this.state.error = '请输入 HTTPS 服务地址，模拟器联调可用 http://127.0.0.1:3000';
      this.emit();
      return;
    }
    this.stream.stop();
    this.baseline = 0;
    this.state = {
      requested: true, status: '连接中', received: 0, lastSequence: 0,
      duplicates: 0, gaps: 0, reconnects: 0, resets: 0, message: '', error: ''
    };
    this.stream.start(`${base}/api/dev/events`);
    this.state.requested = true;
    this.emit();
  }

  disconnect(): void {
    this.stream.stop();
    this.state.requested = false;
    this.emit();
  }

  reconnect(): void { this.stream.reconnect(); }
  setForeground(foreground: boolean): void { this.stream.setForeground(foreground); }
  release(): void { this.disconnect(); }

  private receive(event: StreamEvent): void {
    if (event.event === 'reset') {
      this.state.resets++;
      this.baseline = 0;
      this.state.message = '历史窗口已过期，已获取当前快照';
      this.emit();
      return;
    }
    if (event.event !== 'probe') return;
    const payload: ProbePayload = JSON.parse(event.data) as ProbePayload;
    if (payload.version !== 1 || !Number.isSafeInteger(payload.sequence) || payload.sequence <= 0 ||
      typeof payload.message !== 'string' || typeof payload.serverTime !== 'string' ||
      event.id !== payload.sequence.toString()) {
      throw new Error('收到无效的连接验证事件');
    }
    this.state.received++;
    if (this.baseline > 0 && payload.sequence <= this.baseline) {
      this.state.duplicates++;
    } else {
      if (this.baseline > 0 && payload.sequence > this.baseline + 1) {
        this.state.gaps += payload.sequence - this.baseline - 1;
      }
      this.baseline = payload.sequence;
      this.state.lastSequence = payload.sequence;
    }
    this.state.message = payload.message;
    hilog.info(0x1000, 'YuQuEvents',
      'probe received=%{public}d sequence=%{public}d duplicates=%{public}d gaps=%{public}d reconnects=%{public}d resets=%{public}d',
      this.state.received, this.state.lastSequence, this.state.duplicates, this.state.gaps,
      this.state.reconnects, this.state.resets);
    this.emit();
  }

  private updateStream(stream: StreamState): void {
    const labels: Record<string, string> = {
      'stopped': '未连接', 'paused': '后台暂停连接', 'connecting': '连接中',
      'connected': '已连接', 'retrying': '等待重连', 'error': '连接失败'
    };
    this.state.status = labels[stream.status] || stream.status;
    this.state.reconnects = stream.reconnects;
    this.state.error = stream.error;
    if (stream.status === 'stopped' || stream.status === 'error') this.state.requested = false;
    this.emit();
  }

  private emit(): void {
    const snapshot: ProbeViewState = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
