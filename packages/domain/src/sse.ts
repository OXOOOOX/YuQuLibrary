export interface ServerEvent {
  event: string;
  data: string;
  id?: string;
}

/** Incremental parser for the event contract, including split UTF-8 and CRLF. */
export class SseDecoder {
  private decoder = new TextDecoder();
  private buffer = '';
  private event = 'message';
  private data: string[] = [];
  private dataSize = 0;
  private lastId: string | undefined;
  private skipLeadingLf = false;

  push(chunk: Uint8Array): ServerEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (this.skipLeadingLf && this.buffer.length > 0) {
      if (this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1);
      this.skipLeadingLf = false;
    }
    const output: ServerEvent[] = [];
    while (true) {
      const end = this.buffer.search(/[\r\n]/);
      if (end < 0) break;
      if (end > 64 * 1024) throw new Error('Event line exceeds 64 KiB');
      const line = this.buffer.slice(0, end);
      const skip = this.buffer[end] === '\r' && this.buffer[end + 1] === '\n' ? 2 : 1;
      this.skipLeadingLf = this.buffer[end] === '\r' && end === this.buffer.length - 1;
      this.buffer = this.buffer.slice(end + skip);
      if (line === '') {
        if (this.data.length > 0) {
          output.push({ event: this.event, data: this.data.join('\n'), ...(this.lastId !== undefined ? { id: this.lastId } : {}) });
        }
        this.event = 'message';
        this.data = [];
        this.dataSize = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value || 'message';
      if (field === 'data') {
        this.dataSize += value.length + (this.data.length > 0 ? 1 : 0);
        if (this.dataSize > 64 * 1024) throw new Error('Event exceeds 64 KiB');
        this.data.push(value);
      }
      if (field === 'id' && !value.includes('\0')) this.lastId = value;
    }
    if (this.buffer.length > 64 * 1024) throw new Error('Event line exceeds 64 KiB');
    return output;
  }
}
