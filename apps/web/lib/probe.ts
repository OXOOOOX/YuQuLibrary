import type { ProbeEvent } from '@yuqu/contracts';

/** A deterministic per-second diagnostic feed, never user data. */
export function probeResponse(request: Request): Response {
  const cursor = request.headers.get('last-event-id');
  if (cursor && !/^\d{1,12}$/.test(cursor)) return new Response(null, { status: 400 });
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let stopped = false;
      let liveCount = 0;
      let last = cursor ? Number(cursor) : 0;
      const close = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', close);
        controller.close();
      };
      cancel = () => {
        stopped = true;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', close);
      };
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener('abort', close, { once: true });
      controller.enqueue(encoder.encode('retry: 1000\n\n'));
      const tick = () => {
        if (stopped) return;
        const now = Math.floor(Date.now() / 1000);
        if (last > now || (last > 0 && last < now - 120)) {
          controller.enqueue(encoder.encode('event: reset\ndata: {"reason":"cursor_expired"}\n\n'));
          last = 0;
        }
        for (let sequence = last > 0 ? last + 1 : now; sequence <= now; sequence++) {
          const event: ProbeEvent = {
            version: 1, sequence, serverTime: new Date(sequence * 1000).toISOString(), message: '鱼趣连接正常'
          };
          controller.enqueue(encoder.encode(`id: ${sequence}\nevent: probe\ndata: ${JSON.stringify(event)}\n\n`));
          last = sequence;
        }
        // Intentional rotation exercises reconnect and Last-Event-ID on both clients.
        if (++liveCount >= 15) { close(); return; }
        timer = setTimeout(tick, 1000);
      };
      tick();
    },
    cancel() { cancel(); }
  });
  return new Response(body, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  } });
}
