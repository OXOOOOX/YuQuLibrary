'use client';

import { useEffect, useRef, useState } from 'react';
import type { ProbeEvent } from '@yuqu/contracts';

export function ConnectionProbe() {
  const source = useRef<EventSource | null>(null);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('尚未连接');
  const [stats, setStats] = useState({ count: 0, last: 0, gaps: 0, duplicates: 0, reconnects: 0, resets: 0 });
  useEffect(() => () => source.current?.close(), []);

  function toggle() {
    if (source.current) {
      source.current.close(); source.current = null;
      setActive(false); setStatus('已断开'); return;
    }
    setActive(true); setStatus('连接中…');
    setStats({ count: 0, last: 0, gaps: 0, duplicates: 0, reconnects: 0, resets: 0 });
    const connection = new EventSource('/api/dev/events');
    source.current = connection;
    let opened = false;
    connection.onopen = () => {
      if (source.current !== connection) return;
      setStatus('已连接');
      if (opened) setStats(value => ({ ...value, reconnects: value.reconnects + 1 }));
      opened = true;
    };
    connection.addEventListener('reset', () => setStats(value => ({ ...value, last: 0, resets: value.resets + 1 })));
    connection.addEventListener('probe', (message: MessageEvent<string>) => {
      if (source.current !== connection) return;
      const event = JSON.parse(message.data) as ProbeEvent;
      setStatus(event.message);
      setStats(value => ({ ...value,
        count: value.count + 1, last: event.sequence,
        gaps: value.gaps + (value.last > 0 ? Math.max(0, event.sequence - value.last - 1) : 0),
        duplicates: value.duplicates + (event.sequence <= value.last ? 1 : 0)
      }));
    });
    connection.onerror = () => {
      if (source.current !== connection) return;
      if (connection.readyState === EventSource.CLOSED) {
        source.current = null; setActive(false); setStatus('连接不可用；仅开发模式开放');
      } else setStatus('连接中断，正在恢复…');
    };
  }

  return <details><summary>连接验证</summary><div className="diagnostics">
    <p>开发测试事件每秒一条，每 15 秒重连一次；只验证传输，不包含用户数据。</p>
    <p role="status">{status}</p>
    <p data-testid="probe-stats">已收 {stats.count} · 最新 {stats.last} · 重连 {stats.reconnects} · 缺口 {stats.gaps} · 重复 {stats.duplicates} · 重置 {stats.resets}</p>
    <button onClick={toggle}>{active ? '断开连接' : '测试事件连接'}</button>
  </div></details>;
}
