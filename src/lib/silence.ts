import { run } from './process.js';

export interface SilenceReport {
  leadingSec: number;
  trailingSec: number;
}

const DEFAULT_THRESHOLD_DB = -40;
const DEFAULT_MIN_DURATION_SEC = 0.5;
const EPSILON_LEADING_SEC = 0.05;

interface SilenceEvent {
  start: number;
  end: number | null;
}

export function parseSilencedetectStderr(stderr: string, totalDurationSec: number): SilenceReport {
  const events: SilenceEvent[] = [];
  let current: SilenceEvent | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([-\d.]+)/);
    if (startMatch) {
      if (current) events.push(current);
      current = { start: Number.parseFloat(startMatch[1]!), end: null };
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([-\d.]+)/);
    if (endMatch && current) {
      current.end = Number.parseFloat(endMatch[1]!);
      events.push(current);
      current = null;
    }
  }
  if (current) events.push(current);

  let leadingSec = 0;
  let trailingSec = 0;

  for (const ev of events) {
    if (ev.start <= EPSILON_LEADING_SEC && ev.end != null && ev.end > 0) {
      leadingSec = Math.max(leadingSec, ev.end);
    }
    if (totalDurationSec > 0) {
      const endsAtClipEnd = ev.end == null || Math.abs(ev.end - totalDurationSec) <= EPSILON_LEADING_SEC;
      if (endsAtClipEnd && ev.start > 0 && ev.start < totalDurationSec) {
        const trail = totalDurationSec - ev.start;
        if (trail > trailingSec) trailingSec = trail;
      }
    }
  }

  return { leadingSec, trailingSec };
}

export async function detectSilence(
  audioPath: string,
  totalDurationSec: number,
  thresholdDb: number = DEFAULT_THRESHOLD_DB,
  minDurationSec: number = DEFAULT_MIN_DURATION_SEC,
): Promise<SilenceReport> {
  const filter = `silencedetect=n=${thresholdDb}dB:d=${minDurationSec}`;
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i', audioPath,
    '-af', filter,
    '-f', 'null',
    '-',
  ]);
  return parseSilencedetectStderr(stderr, totalDurationSec);
}

export async function trimSilence(
  srcPath: string,
  dstPath: string,
  totalDurationSec: number,
  leadingSec: number,
  trailingSec: number,
): Promise<void> {
  const keepDuration = Math.max(0, totalDurationSec - leadingSec - trailingSec);
  await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-y',
    '-ss', String(leadingSec),
    '-i', srcPath,
    '-t', String(keepDuration),
    '-c', 'copy',
    dstPath,
  ]);
}
