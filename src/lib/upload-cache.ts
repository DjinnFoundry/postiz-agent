import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { readJsonOr } from './json-file.js';

/**
 * Dedup cache for Postiz media uploads. Keyed by SHA256 of the file content so
 * retries of `createPost` after a successful `uploadMedia` don't re-upload the
 * MP4 (saves bandwidth and Postiz quota when a 4xx hits mid-flow).
 *
 * Storage: simple JSON file at `data/upload-cache.json`. TTL guards against
 * Postiz GC'ing server-side media we thought were still valid.
 */

const DEFAULT_CACHE_PATH = resolve(config.paths.projectRoot, 'data', 'upload-cache.json');
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface CachedUpload {
  mediaId: string;
  path?: string;
  uploadedAt: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CachedUpload>;
}

export class UploadCache {
  constructor(
    private readonly cachePath: string = DEFAULT_CACHE_PATH,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** SHA256 hex of a file's contents, streamed so we don't load large MP4s into RAM. */
  async hashFile(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    await new Promise<void>((ok, reject) => {
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => ok());
      stream.on('error', reject);
    });
    return hash.digest('hex');
  }

  get(sha256: string): CachedUpload | undefined {
    const file = this.readFile();
    const entry = file.entries[sha256];
    if (!entry) return undefined;
    const uploadedMs = Date.parse(entry.uploadedAt);
    if (!Number.isFinite(uploadedMs)) return undefined;
    if (this.now().getTime() - uploadedMs > this.ttlMs) return undefined;
    return entry;
  }

  set(sha256: string, upload: Omit<CachedUpload, 'uploadedAt'>): CachedUpload {
    const file = this.readFile();
    const entry: CachedUpload = { ...upload, uploadedAt: this.now().toISOString() };
    file.entries[sha256] = entry;
    this.writeFile(file);
    return entry;
  }

  invalidate(sha256: string): void {
    const file = this.readFile();
    if (!(sha256 in file.entries)) return;
    delete file.entries[sha256];
    this.writeFile(file);
  }

  /** Drop entries older than ttlMs. Call periodically from dispatch/status. */
  prune(): number {
    const file = this.readFile();
    const cutoff = this.now().getTime() - this.ttlMs;
    let dropped = 0;
    for (const [key, entry] of Object.entries(file.entries)) {
      const t = Date.parse(entry.uploadedAt);
      if (!Number.isFinite(t) || t < cutoff) {
        delete file.entries[key];
        dropped++;
      }
    }
    if (dropped) this.writeFile(file);
    return dropped;
  }

  countStale(): number {
    const file = this.readFile();
    const cutoff = this.now().getTime() - this.ttlMs;
    let stale = 0;
    for (const entry of Object.values(file.entries)) {
      const t = Date.parse(entry.uploadedAt);
      if (!Number.isFinite(t) || t < cutoff) stale++;
    }
    return stale;
  }

  /** Lightweight digest used by doctor/status. `exists` distinguishes a brand-new
   *  tenant (count=0, file absent) from a tenant whose cache happens to be empty. */
  summarize(): { count: number; oldestUploadedAt: string | null; exists: boolean } {
    const exists = existsSync(this.cachePath);
    const file = this.readFile();
    const stamps = Object.values(file.entries).map(e => e.uploadedAt).filter(Boolean).sort();
    return {
      count: Object.keys(file.entries).length,
      oldestUploadedAt: stamps[0] ?? null,
      exists,
    };
  }

  private readFile(): CacheFile {
    return readJsonOr<CacheFile>(this.cachePath, { version: 1, entries: {} }, {
      validate: (raw) => {
        const parsed = raw as Partial<CacheFile> | null;
        if (!parsed || parsed.version !== 1) return undefined;
        if (!parsed.entries || typeof parsed.entries !== 'object') return undefined;
        return parsed as CacheFile;
      },
    });
  }

  private writeFile(data: CacheFile): void {
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(data, null, 2));
  }
}

/** Timeout scaling: base 15s, grows linearly with file size assuming 200kbps worst-case uplink. */
export function computeUploadTimeoutMs(fileSizeBytes: number, opts: { baseMs?: number; minKbps?: number; padding?: number } = {}): number {
  const baseMs = opts.baseMs ?? 15_000;
  const minKbps = opts.minKbps ?? 200;
  const padding = opts.padding ?? 1.5;
  const bytesPerMs = (minKbps * 1024 / 8) / 1000; // kbps → bytes/ms
  const theoretical = fileSizeBytes / bytesPerMs;
  return Math.max(baseMs, Math.round(theoretical * padding));
}
