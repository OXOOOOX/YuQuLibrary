import { bundleManager } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { deviceInfo } from '@kit.BasicServicesKit';

type DiagnosticEventType = 'play' | 'pause' | 'buffer_start' | 'buffer_end' | 'seek' | 'seek_done' |
  'error' | 'retry' | 'resumed' | 'foreground' | 'background' | 'transcript_failed';

interface DiagnosticEvent {
  type: DiagnosticEventType;
  atMs: number;
  positionMs: number;
  code?: number;
  attempts?: number;
}

export interface DiagnosticReport {
  reportId: string;
  kind: 'playback' | 'transcription';
  mediaVersionId: string;
  jobId?: string;
  appVersion?: string;
  sdkApi?: number;
  events: DiagnosticEvent[];
}

const EVENT_LIMIT: number = 20;

function position(value: number): number {
  return Number.isFinite(value) ? Math.min(14400000, Math.max(0, Math.round(value))) : 0;
}

function addVersions(report: DiagnosticReport): void {
  try {
    const version = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT).versionName;
    if (/^\d{1,5}(\.\d{1,5}){1,3}$/.test(version)) report.appVersion = version;
  } catch (_error) {}
  try {
    const api = deviceInfo.sdkApiVersion;
    if (Number.isInteger(api) && api >= 1 && api <= 1000) report.sdkApi = api;
  } catch (_error) {}
}

export function createTranscriptDiagnosticReport(mediaVersionId: string, jobId: string, completedMs: number,
  attempts: number, failedAt: number): DiagnosticReport {
  const event: DiagnosticEvent = { type: 'transcript_failed',
    atMs: Number.isSafeInteger(failedAt) && failedAt >= 0 && failedAt <= 8640000000000000 ? failedAt : Date.now(),
    positionMs: position(completedMs) };
  if (Number.isInteger(attempts) && attempts >= 0 && attempts <= 3) event.attempts = attempts;
  const report: DiagnosticReport = { reportId: util.generateRandomUUID(), kind: 'transcription',
    mediaVersionId: mediaVersionId, jobId: jobId, events: [event] };
  addVersions(report);
  return report;
}

// Copy only fields the user can inspect. Native errors and display logs never enter this data structure.
function copyEvent(event: DiagnosticEvent): DiagnosticEvent {
  const copy: DiagnosticEvent = { type: event.type, atMs: event.atMs, positionMs: event.positionMs };
  if (event.code !== undefined) copy.code = event.code;
  if (event.attempts !== undefined) copy.attempts = event.attempts;
  return copy;
}

export class PlaybackDiagnostics {
  private mediaVersionId: string = '';
  private recent: DiagnosticEvent[] = [];
  private report?: DiagnosticReport;
  private rootError?: DiagnosticEvent;
  private collectingRecovery: boolean = false;
  private sealed: boolean = false;

  get incidentId(): string { return this.report?.reportId ?? ''; }

  reset(mediaVersionId: string = ''): void {
    this.mediaVersionId = mediaVersionId;
    this.recent = [];
    this.report = undefined;
    this.rootError = undefined;
    this.collectingRecovery = false;
    this.sealed = false;
  }

  record(type: DiagnosticEventType, positionMs: number, code?: number): void {
    if (this.mediaVersionId.length === 0) return;
    const lastAt = this.recent.length === 0 ? 0 : this.recent[this.recent.length - 1].atMs;
    const event: DiagnosticEvent = { type: type, atMs: Math.max(lastAt, Date.now()), positionMs: position(positionMs) };
    if (type === 'error' && code !== undefined && Number.isInteger(code) && code >= 0 && code <= 2147483647) {
      event.code = code;
    }
    this.recent.push(event);
    if (this.recent.length > EVENT_LIMIT) this.recent.shift();
    if (this.collectingRecovery && !this.sealed && this.report !== undefined) {
      const events = this.report.events;
      events.push(event);
      if (events.length > EVENT_LIMIT) events.splice(events[0] === this.rootError ? 1 : 0, 1);
    }
    if (type === 'resumed') this.collectingRecovery = false;
  }

  fail(positionMs: number, recovering: boolean, code?: number): void {
    if (this.mediaVersionId.length === 0) return;
    this.collectingRecovery = false;
    this.record('error', positionMs, code);
    this.rootError = this.recent[this.recent.length - 1];
    this.report = { reportId: util.generateRandomUUID(), kind: 'playback', mediaVersionId: this.mediaVersionId,
      events: this.recent.slice() };
    this.collectingRecovery = recovering;
    this.sealed = false;
  }

  endRecovery(): void { this.collectingRecovery = false; }

  snapshot(): DiagnosticReport | undefined {
    const report = this.report;
    if (report === undefined) return undefined;
    if (!this.sealed) {
      addVersions(report);
      this.sealed = true;
    }
    const copy: DiagnosticReport = { reportId: report.reportId, kind: report.kind, mediaVersionId: report.mediaVersionId,
      events: report.events.map((event: DiagnosticEvent) => copyEvent(event)) };
    if (report.appVersion !== undefined) copy.appVersion = report.appVersion;
    if (report.sdkApi !== undefined) copy.sdkApi = report.sdkApi;
    return copy;
  }
}

function eventName(type: DiagnosticEventType): string {
  switch (type) {
    case 'play': return '开始播放';
    case 'pause': return '暂停播放';
    case 'buffer_start': return '开始缓冲';
    case 'buffer_end': return '缓冲结束';
    case 'seek': return '请求跳转';
    case 'seek_done': return '已定位';
    case 'error': return '播放失败';
    case 'retry': return '尝试重连';
    case 'resumed': return '已续播';
    case 'foreground': return '进入前台';
    case 'background': return '进入后台';
    case 'transcript_failed': return '转写失败';
  }
}

export function diagnosticPreview(report: DiagnosticReport): string {
  const lines: string[] = [report.kind === 'playback' ? '类型：播放' : '类型：转写',
    '报告编号：' + report.reportId, '音频版本：' + report.mediaVersionId];
  if (report.jobId !== undefined) lines.push('转写任务：' + report.jobId);
  if (report.appVersion !== undefined) lines.push('应用版本：' + report.appVersion);
  if (report.sdkApi !== undefined) lines.push('系统 API：' + report.sdkApi.toString());
  report.events.forEach((event: DiagnosticEvent) => {
    let line = new Date(event.atMs).toISOString() + '  ' + eventName(event.type) + ' · 进度 ' + event.positionMs.toString() + ' 毫秒';
    if (event.code !== undefined) line += ' · 错误码 ' + event.code.toString();
    if (event.attempts !== undefined) line += ' · 已尝试 ' + event.attempts.toString() + ' 次';
    lines.push(line);
  });
  return lines.join('\n');
}
