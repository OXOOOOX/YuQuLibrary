import type { PlaybackReport } from '@yuqu/contracts';

interface AudioObservation { ended: boolean; paused: boolean; currentTime: number; readyState: number }

/** A transient ended flag after seeking must not mark an earlier position complete. */
export function observedPlaybackState(audio: AudioObservation, durationMs: number): PlaybackReport['state'] {
  const positionMs = audio.currentTime * 1000;
  const atEnd = Number.isFinite(positionMs) && Number.isFinite(durationMs) && durationMs > 0 &&
    positionMs >= durationMs - 250;
  if (audio.ended && atEnd) return 'ended';
  if (audio.paused) return 'paused';
  return audio.readyState < 3 ? 'buffering' : 'playing';
}
