/**
 * CliError is the user-facing equivalent of `console.error(msg); process.exit(N)`.
 *
 * Two reasons to centralise it:
 *   1. Command actions stop calling process.exit themselves — the entry point
 *      in src/cli.ts owns the lifecycle, so adding structured exit logging or
 *      changing the exit-on-error policy is one edit instead of twenty-two.
 *   2. Throws are easier to reason about than mid-action terminations: the
 *      stack unwinds, finally blocks run, async operations get a chance to
 *      cancel. process.exit interrupts everything.
 *
 * NOT a replacement for "the command completed; emit a non-zero exit because
 * the report says so" sites (publish on fatalCaptionFailure, status on
 * required-check-failed, etc.). Those are status codes, not errors. They
 * stay as `process.exit(N)` after the JSON / human report has been printed.
 */
export class CliError extends Error {
  override readonly name = 'CliError';
  constructor(message: string, readonly exitCode: number = 1) {
    super(message);
  }
}
