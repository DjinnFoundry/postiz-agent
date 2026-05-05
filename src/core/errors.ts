/**
 * Error taxonomy with machine-readable remediation hints.
 *
 * Every failure in PostizAgent (Postiz 4xx, Whisper model missing, HyperFrames lint
 * break, YouTubeCLI auth drift…) is turned into a ClassifiedError here. This is the
 * single source of truth the retry helper, dispatch backoff, decision log and CLI
 * consume. It's what lets an external agent read a failed decision entry and
 * *know* whether to retry, reconfigure, or escalate.
 *
 * Kinds:
 *  - transient     — worth retrying (network blip, 5xx, rate limit). Retry helper
 *                    will backoff and re-invoke.
 *  - permanent     — the same call will keep failing. Don't retry today. A human
 *                    or a later code change unblocks it (corrupt asset, bad slug,
 *                    4xx validation).
 *  - needs-config  — missing/wrong configuration (API key, model, integration).
 *                    Machine-fixable with a documented command in `remediation`.
 *  - needs-human   — requires judgement or credentials we can't automate (YouTube
 *                    auth re-consent, Postiz tier upgrade, fragile regex break).
 *  - unknown       — default fallthrough; treated as permanent to avoid loops,
 *                    surfaced to the alert webhook for humans to investigate.
 */

export type ErrorKind = 'transient' | 'permanent' | 'needs-config' | 'needs-human' | 'unknown';

export type ErrorOrigin =
  | 'postiz'
  | 'whisper'
  | 'hyperframes'
  | 'ffmpeg'
  | 'ffprobe'
  | 'youtube-cli'
  | 'network'
  | 'filesystem'
  | 'validation'
  | 'unknown';

export interface Remediation {
  /** Machine-readable remediation token. E.g. 'retry', 'reconnect-integration'. */
  action: string;
  /** Human-readable suggestion. One sentence, imperative mood. */
  humanHint: string;
  /** Optional structured payload for the action (e.g. `{command: 'whisper --model base --download'}`). */
  args?: Record<string, unknown>;
}

export interface ClassifiedError {
  kind: ErrorKind;
  origin: ErrorOrigin;
  message: string;
  retryable: boolean;
  remediation?: Remediation;
}

/**
 * Build the canonical "publish failed" PublishResult shape from a thrown
 * value. Three publishers used to inline the same construction in their
 * catch blocks (orchestrator.publishWithRetry, base.VideoPublisher.publish,
 * instagram-publisher.publishPart) — same five fields, same optional
 * remediation spread, easy to drift apart on the next change. Centralised
 * here so the failure shape is canonical and tests around it stay
 * meaningful.
 *
 * `extras` is the publisher-specific tail (e.g. partIndex / partTotal for
 * Instagram multi-part). The base shape always wins for the five core
 * fields; extras add to it.
 */
export function buildClassifiedFailure(
  platform: import('../types.js').Platform,
  err: unknown,
  opts: { origin?: ErrorOrigin; extras?: Partial<import('../types.js').PublishResult> } = {},
): import('../types.js').PublishResult {
  const classified = classifyError(err, opts.origin ? { origin: opts.origin } : {});
  return {
    platform,
    success: false,
    error: classified.message,
    errorClass: classified.kind,
    ...(classified.remediation ? { remediation: classified.remediation } : {}),
    timestamp: new Date().toISOString(),
    ...(opts.extras ?? {}),
  };
}

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EPIPE', 'ENOTFOUND',
]);
const NEEDS_CONFIG_CODES = new Set(['ECONNREFUSED']);

/**
 * Turn any thrown value into a ClassifiedError. Accepts an optional origin hint
 * (what subsystem we were talking to when it blew up) so the classifier can pick
 * the right heuristic when the error message alone is ambiguous.
 */
export function classifyError(err: unknown, opts: { origin?: ErrorOrigin } = {}): ClassifiedError {
  const hintedOrigin = opts.origin;
  if (err == null) {
    return { kind: 'unknown', origin: hintedOrigin ?? 'unknown', message: 'unknown error (null)', retryable: false };
  }

  const anyErr = err as { code?: string; message?: string };
  const message = anyErr.message ?? String(err);
  const code = anyErr.code;

  // ─── Network layer ──────────────────────────────────────────────────────
  if (code && NETWORK_CODES.has(code)) {
    return {
      kind: 'transient', origin: 'network', message, retryable: true,
      remediation: { action: 'retry', humanHint: `transient network error (${code}); will retry` },
    };
  }
  if (code && NEEDS_CONFIG_CODES.has(code)) {
    return {
      kind: 'needs-config', origin: 'network', message, retryable: false,
      remediation: {
        action: 'check-service',
        humanHint: `connection refused; verify the target service is running and reachable`,
        args: { code },
      },
    };
  }

  // ─── HTTP status detection (generic, wrapped fetch errors) ──────────────
  const statusMatch = message.match(/\b(\d{3})\b/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  // ─── Postiz-specific patterns ───────────────────────────────────────────
  if (hintedOrigin === 'postiz' || /postiz|integration not found/i.test(message)) {
    if (status === 401 || /unauthorized|invalid api key/i.test(message)) {
      return {
        kind: 'needs-config', origin: 'postiz', message, retryable: false,
        remediation: {
          action: 'update-api-key',
          humanHint: 'Postiz auth failed; regenerate POSTIZ_API_KEY in the Postiz UI and update .env',
        },
      };
    }
    if (status === 403 || /pay.?per.?use|forbidden|quota/i.test(message)) {
      return {
        kind: 'needs-config', origin: 'postiz', message, retryable: false,
        remediation: {
          action: 'fund-or-upgrade-postiz',
          humanHint: 'Postiz rejected the request (403/quota); fund the account or upgrade tier in the Postiz UI',
        },
      };
    }
    if (/integration not found/i.test(message) || status === 404) {
      return {
        kind: 'needs-config', origin: 'postiz', message, retryable: false,
        remediation: {
          action: 'reconnect-integration',
          humanHint: 'the target platform is not connected in Postiz; reconnect it in Postiz UI → Integrations',
        },
      };
    }
    if (status === 429 || /rate limit|too many requests/i.test(message)) {
      return {
        kind: 'transient', origin: 'postiz', message, retryable: true,
        remediation: { action: 'retry', humanHint: 'Postiz rate-limited; backoff and retry' },
      };
    }
    if (status && status >= 500) {
      return {
        kind: 'transient', origin: 'postiz', message, retryable: true,
        remediation: { action: 'retry', humanHint: `Postiz server error ${status}; retry` },
      };
    }
    if (status && status >= 400) {
      return {
        kind: 'permanent', origin: 'postiz', message, retryable: false,
        remediation: {
          action: 'manual-review',
          humanHint: `Postiz rejected the payload (${status}); inspect the request and fix the caption/video`,
        },
      };
    }
  }

  // ─── Whisper ────────────────────────────────────────────────────────────
  if (hintedOrigin === 'whisper' || /whisper|did not produce expected JSON/i.test(message)) {
    if (/model.*(not found|missing|could not be loaded)/i.test(message)) {
      return {
        kind: 'needs-config', origin: 'whisper', message, retryable: false,
        remediation: {
          action: 'download-whisper-model',
          humanHint: 'Whisper model is missing; run `whisper --model base --help` to trigger a download or install the model manually',
        },
      };
    }
    if (/audio not found/i.test(message)) {
      return {
        kind: 'permanent', origin: 'whisper', message, retryable: false,
        remediation: { action: 'regenerate-source', humanHint: 'audio file missing at the expected path; re-run the source pipeline' },
      };
    }
    return {
      kind: 'permanent', origin: 'whisper', message, retryable: false,
      remediation: { action: 'manual-review', humanHint: 'Whisper failed unexpectedly; inspect stderr' },
    };
  }

  // ─── HyperFrames ────────────────────────────────────────────────────────
  if (hintedOrigin === 'hyperframes' || /hyperframes|template for mood/i.test(message)) {
    if (/no hyperframes template for mood/i.test(message)) {
      return {
        kind: 'permanent', origin: 'hyperframes', message, retryable: false,
        remediation: {
          action: 'add-template',
          humanHint: 'the requested mood template does not exist; add hyperframes/templates/<mood>.mjs or set an explicit treatment',
        },
      };
    }
    if (/lint|validation/i.test(message)) {
      return {
        kind: 'permanent', origin: 'hyperframes', message, retryable: false,
        remediation: { action: 'fix-template', humanHint: 'HyperFrames linter rejected the composition; fix template errors' },
      };
    }
    if (/produced no output|render failed/i.test(message)) {
      return {
        kind: 'permanent', origin: 'hyperframes', message, retryable: false,
        remediation: { action: 'fix-template', humanHint: 'HyperFrames render produced no MP4; inspect data/render-logs/ for stderr' },
      };
    }
  }

  // ─── YouTube CLI ────────────────────────────────────────────────────────
  if (hintedOrigin === 'youtube-cli' || /youtubecli|videoId/i.test(message)) {
    if (/could not parse videoId/i.test(message)) {
      return {
        kind: 'needs-human', origin: 'youtube-cli', message, retryable: false,
        remediation: {
          action: 'inspect-youtubecli-output',
          humanHint: 'videoId regex did not match; YouTubeCLI output format may have changed or the upload was rejected. Inspect raw stdout',
        },
      };
    }
    if (/path not found/i.test(message)) {
      return {
        kind: 'needs-config', origin: 'youtube-cli', message, retryable: false,
        remediation: { action: 'set-youtubecli-path', humanHint: 'YOUTUBECLI_PATH is not set or points to a missing directory' },
      };
    }
    if (/video not found/i.test(message)) {
      return {
        kind: 'permanent', origin: 'youtube-cli', message, retryable: false,
        remediation: { action: 'regenerate-source', humanHint: 'rendered MP4 missing before YouTube upload' },
      };
    }
  }

  // ─── ffmpeg / ffprobe ───────────────────────────────────────────────────
  if (hintedOrigin === 'ffmpeg' || hintedOrigin === 'ffprobe' || /ffmpeg|ffprobe/i.test(message)) {
    if (/codec|encoder.*not found/i.test(message)) {
      return {
        kind: 'needs-config', origin: 'ffmpeg', message, retryable: false,
        remediation: { action: 'reinstall-ffmpeg', humanHint: 'ffmpeg build lacks the required codec; install a full ffmpeg (e.g. `brew install ffmpeg`)' },
      };
    }
    return {
      kind: 'permanent', origin: 'ffmpeg', message, retryable: false,
      remediation: { action: 'manual-review', humanHint: 'ffmpeg/ffprobe failed; inspect stderr of the failing invocation' },
    };
  }

  // ─── Filesystem / validation ────────────────────────────────────────────
  if (/ENOENT|not found|no such file/i.test(message)) {
    return {
      kind: 'permanent', origin: 'filesystem', message, retryable: false,
      remediation: { action: 'regenerate-source', humanHint: 'expected file is missing on disk' },
    };
  }
  if (/Invalid slug|validation|ZodError/i.test(message)) {
    return {
      kind: 'permanent', origin: 'validation', message, retryable: false,
      remediation: { action: 'fix-input', humanHint: 'input failed schema validation; inspect the error details and fix the source data' },
    };
  }

  // ─── Generic HTTP fallback ──────────────────────────────────────────────
  if (status) {
    if (status === 429) return { kind: 'transient', origin: hintedOrigin ?? 'unknown', message, retryable: true, remediation: { action: 'retry', humanHint: 'rate limited; retry with backoff' } };
    if (status >= 500) return { kind: 'transient', origin: hintedOrigin ?? 'unknown', message, retryable: true, remediation: { action: 'retry', humanHint: `upstream ${status}; retry` } };
    if (status >= 400) return { kind: 'permanent', origin: hintedOrigin ?? 'unknown', message, retryable: false, remediation: { action: 'manual-review', humanHint: `upstream rejected (${status})` } };
  }

  // ─── Generic signals ────────────────────────────────────────────────────
  if (/network|socket hang up|timeout|temporarily unavailable/i.test(message)) {
    return {
      kind: 'transient', origin: 'network', message, retryable: true,
      remediation: { action: 'retry', humanHint: 'transient network signal; retry' },
    };
  }

  return { kind: 'unknown', origin: hintedOrigin ?? 'unknown', message, retryable: false };
}
