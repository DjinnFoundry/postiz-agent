import { run } from './process.js';

export async function probeDurationSec(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    path,
  ]);
  return parseFloat(stdout.trim()) || 0;
}

export async function probeBitrateKbps(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=bit_rate',
    '-of', 'csv=p=0',
    path,
  ]);
  const raw = stdout.trim();
  if (!raw || /^n\/a$/i.test(raw)) {
    throw new Error(`ffprobe returned no bitrate for audio stream in ${path}`);
  }
  const bps = Number.parseInt(raw, 10);
  if (!Number.isFinite(bps) || bps <= 0) {
    throw new Error(`ffprobe returned invalid bitrate "${raw}" for ${path}`);
  }
  return Math.round(bps / 1000);
}
