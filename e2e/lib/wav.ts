import fs from 'node:fs';

/** 16 kHz mono 16-bit PCM WAV — a 300→1200 Hz sweep so the fake mic carries real signal
 *  (Chromium loops it; audible energy keeps Opus emitting packets and gives STT something). */
export function writeToneWav(file: string, seconds = 8, rate = 16_000) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = 300 + (900 * (t % 2)) / 2;
    const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 2);
    const v = Math.sin(2 * Math.PI * f * t) * 0.6 * env;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}
