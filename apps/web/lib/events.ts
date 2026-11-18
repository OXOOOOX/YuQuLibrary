import type { AccountSession, SyncedPlayback } from '@yuqu/contracts';
import type { Pool } from 'pg';
import { eventBatch } from '@yuqu/domain/playback';
import { AppError } from '@yuqu/domain/errors';

export function playbackEvents(request: Request, pool: Pool, account: AccountSession): Response {
  const raw = request.headers.get('last-event-id');
  if (raw !== null && (!/^\d{1,10}$/.test(raw) || Number(raw) > 2_147_483_646)) throw new AppError(400, 'INVALID_CURSOR', '事件游标无效。');
  let cursor = raw === null ? null : Number(raw);
  const encoder = new TextEncoder();
  let cancel = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = Date.now();
      let lastHeartbeat = started;
      const cleanup = () => { stopped = true; clearTimeout(timer); request.signal.removeEventListener('abort', close); };
      const close = () => { if (!stopped) { cleanup(); controller.close(); } };
      cancel = cleanup;
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener('abort', close, { once: true });
      const send = (kind: string, value: SyncedPlayback) => {
        controller.enqueue(encoder.encode(`id: ${value.revision}\nevent: ${kind}\ndata: ${JSON.stringify(value)}\n\n`));
        cursor = value.revision;
      };
      controller.enqueue(encoder.encode('retry: 1000\n\n'));
      const poll = async () => {
        if (stopped) return;
        try {
          const batch = await eventBatch(pool, account, cursor);
          if (stopped) return;
          if (batch.snapshot) send(batch.reset ? 'reset' : 'snapshot', batch.snapshot);
          for (const value of batch.events) send('playback', value);
          if (Date.now() - lastHeartbeat >= 15000) {
            controller.enqueue(encoder.encode(': heartbeat\n\n')); lastHeartbeat = Date.now();
          }
        } catch (error) {
          if (stopped) return;
          if (error instanceof AppError && error.status === 401) controller.enqueue(encoder.encode('event: session-expired\ndata: {}\n\n'));
          close(); return;
        }
        if (Date.now() - started >= 55000) { close(); return; }
        timer = setTimeout(() => { void poll(); }, 1000);
      };
      void poll();
    },
    cancel() { cancel(); }
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' } });
}
