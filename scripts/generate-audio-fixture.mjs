import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYBACK_FIXTURE } from '../packages/contracts/src/playback.ts';

const { sampleRate, durationMs } = PLAYBACK_FIXTURE;
const samples = sampleRate * durationMs / 1000;
const buffer = Buffer.alloc(44 + samples * 2);
buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
  const second = i / sampleRate;
  const part = second % 1;
  const gate = part < 0.18 ? Math.sin(Math.PI * part / 0.18) : 0;
  const frequency = Math.floor(second) % 10 === 0 ? 660 : 440;
  const value = Math.sin(2 * Math.PI * frequency * second) * gate * 0.12;
  buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
}
for (const relative of ['../apps/web/public/audio/playback-check.wav', '../apps/harmony/entry/src/main/resources/rawfile/playback-check.wav']) {
  const destination = fileURLToPath(new URL(relative, import.meta.url));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, buffer);
}
console.log(`已生成两端相同的 ${durationMs / 1000} 秒 PCM WAV 验证音频（每秒提示音，每十秒高音）。`);
