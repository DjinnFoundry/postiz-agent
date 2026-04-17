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

export async function probeVideoDimensions(path: string): Promise<{ width: number; height: number; durationSec: number }> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration',
    '-of', 'csv=p=0',
    path,
  ]);
  const [width, height, duration] = stdout.trim().split(',');
  return { width: parseInt(width, 10), height: parseInt(height, 10), durationSec: parseFloat(duration) || 0 };
}
