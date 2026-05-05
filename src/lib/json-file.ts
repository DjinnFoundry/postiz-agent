import { existsSync, readFileSync } from 'node:fs';

/**
 * Read a JSON file from disk, returning a fallback value when the file is
 * absent or unparseable. The pattern `existsSync → readFileSync → JSON.parse
 * → catch defaults` was reimplemented six times across stores (TenantContext
 * overrides, ThemeDecisionStore, UploadCache.readFile, doctor's cache reads,
 * etc.). Centralising it has three benefits:
 *
 *   1. Error policy is consistent: parse failure ≡ absent file from the
 *      caller's perspective (the data store stays alive on a corrupt write
 *      partway). Callers that want a different policy can read manually.
 *   2. Optional `validate` runs the parsed value through a Zod schema or any
 *      predicate so callers don't have to remember to type-check before use.
 *   3. Optional `onError` surfaces parse failures to a debug channel without
 *      forcing a throw — useful for `doctor` to flag corrupt caches.
 */
export interface ReadJsonOrOptions<T> {
  /** Predicate / parse step. Return the typed value on success, or undefined to
   *  treat the file as if it were absent (defaults will be returned). Throws
   *  here are caught and routed through onError. */
  validate?: (raw: unknown) => T | undefined;
  /** Side channel for read/parse/validate failures. Fire-and-forget; never
   *  thrown. Receives the file path and the underlying error. */
  onError?: (path: string, err: unknown) => void;
}

export function readJsonOr<T>(path: string, fallback: T, opts: ReadJsonOrOptions<T> = {}): T {
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (opts.validate) {
      const validated = opts.validate(raw);
      return validated ?? fallback;
    }
    return raw as T;
  } catch (err) {
    opts.onError?.(path, err);
    return fallback;
  }
}
