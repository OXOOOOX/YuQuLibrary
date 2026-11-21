import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { TranscriptPage } from '@yuqu/contracts';
import { time } from './knowledge-ui';

interface Press {
  pointer: number; first: number; last: number; x: number; y: number; dragging: boolean;
  hold: ReturnType<typeof setTimeout>; edge?: ReturnType<typeof setInterval>; page: TranscriptPage;
}

export function TranscriptSentences({ page, list, currentId, searchId, chapterId, selected, audioAvailable, playbackBusy, onRange, onSelect, onPlay }: {
  page: TranscriptPage; list: RefObject<HTMLOListElement | null>; currentId?: string; searchId?: string; chapterId?: string;
  selected: readonly string[]; audioAvailable: boolean; playbackBusy: boolean;
  onRange: (page: TranscriptPage, first: number, last: number) => void; onSelect: (index: number) => void; onPlay: (ms: number) => void;
}) {
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  function finish() {
    const p = press.current;
    if (!p) return;
    clearTimeout(p.hold); clearInterval(p.edge); press.current = null;
    if (list.current?.hasPointerCapture(p.pointer)) list.current.releasePointerCapture(p.pointer);
  }
  useEffect(() => {
    const element = list.current;
    // Keep ordinary swipes native. Once a stationary hold starts selection, the same finger can drag freely.
    const touchMove = (event: TouchEvent) => { if (press.current?.dragging && event.cancelable) event.preventDefault(); };
    const cancel = () => finish();
    element?.addEventListener('touchmove', touchMove, { passive: false });
    window.addEventListener('blur', cancel);
    return () => { finish(); element?.removeEventListener('touchmove', touchMove); window.removeEventListener('blur', cancel); };
  }, [list]);
  function extend(p: Press, scroll: boolean) {
    const element = list.current;
    if (!element || !p.dragging) return;
    const bounds = element.getBoundingClientRect();
    if (scroll) {
      const edge = Math.min(36, bounds.height / 5);
      if (p.y < bounds.top + edge) element.scrollTop -= 12;
      else if (p.y > bounds.bottom - edge) element.scrollTop += 12;
    }
    const y = Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, p.y));
    const last = Array.from(element.children).findIndex(child => {
      const rect = child.getBoundingClientRect(); return rect.top <= y && rect.bottom > y;
    });
    if (last >= 0 && last !== p.last) { p.last = last; onRange(p.page, p.first, last); }
  }
  function down(event: PointerEvent<HTMLButtonElement>, index: number) {
    if (!event.isPrimary || event.button !== 0) { finish(); return; }
    finish(); suppressClick.current = false;
    const p: Press = { pointer: event.pointerId, first: index, last: index, x: event.clientX, y: event.clientY, page, dragging: false,
      hold: setTimeout(() => {
        if (press.current !== p || !list.current) return;
        p.dragging = true; suppressClick.current = true; onRange(p.page, p.first, p.first);
        list.current.setPointerCapture(p.pointer);
      }, 430) };
    press.current = p;
  }
  function move(event: PointerEvent<HTMLOListElement>) {
    const p = press.current;
    if (!p || event.pointerId !== p.pointer) return;
    if (!p.dragging) {
      if (Math.hypot(event.clientX - p.x, event.clientY - p.y) > 8) { suppressClick.current = true; finish(); }
      return;
    }
    event.preventDefault(); p.y = event.clientY; extend(p, false);
    p.edge ??= setInterval(() => extend(p, true), 55);
  }
  function key(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === ' ') { event.preventDefault(); if (!event.repeat) onSelect(index); return; }
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(page.segments.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
    if (event.shiftKey) {
      if (!selected.length) onRange(page, index, next); else onSelect(next);
    }
    list.current?.children[next]?.querySelector('button')?.focus();
  }
  return <ol ref={list} className="transcript-segments" aria-label="当前文稿片段" onPointerMove={move}
    onPointerUp={finish} onPointerCancel={finish} onPointerLeave={() => { if (!press.current?.dragging) finish(); }}
    onLostPointerCapture={event => { if (event.target === list.current) finish(); }}
    onContextMenu={event => { if (press.current || suppressClick.current) event.preventDefault(); }}>
    {page.segments.map((segment, index) => {
      const checked = selected.includes(segment.id);
      const context = searchId === segment.id ? '搜索命中' : chapterId === segment.id ? '章节起点' : '';
      return <li key={segment.id} data-segment-id={segment.id} tabIndex={-1}
        aria-current={currentId === segment.id ? 'time' : undefined} className={`${checked ? 'selected-segment' : ''} ${context ? 'context-hit' : ''}`}>
        <button type="button" className="sentence-action" aria-pressed={selected.length ? checked : undefined}
          aria-label={`${time(segment.startMs)}，${currentId === segment.id ? '当前播放，' : ''}${segment.text}`}
          onPointerDown={event => down(event, index)} onKeyDown={event => key(event, index)}
          onClick={event => {
            if (event.detail && suppressClick.current) { suppressClick.current = false; return; }
            if (selected.length) onSelect(index);
            else if (audioAvailable && !playbackBusy) onPlay(segment.startMs);
            else if (!audioAvailable) onRange(page, index, index);
          }}>
          <span className="transcript-time">{time(segment.startMs)}</span>
          <span className="sentence-text">{context ? <small className="context-hit-label">{context}</small> : null}{segment.text}</span>
          <span className="sentence-check" aria-hidden="true">{checked ? '✓' : ''}</span>
        </button></li>;
    })}
  </ol>;
}
