/**
 * Tiny stdout helpers shared by CLI command actions.
 *
 * Three idioms appeared dozens of times across the commands directory:
 *
 *   process.stdout.write(JSON.stringify(value) + '\n');               (compact JSON)
 *   process.stdout.write(JSON.stringify(value, null, 2) + '\n');      (pretty JSON)
 *   if (opts.json) process.stdout.write(...) else console.log(format) (json-or-human)
 *
 * Wrapping each in a named helper lets the action body read as intent
 * ("this is the JSON output channel for an agent") rather than mechanics
 * ("write a stringified value to stdout with a newline"), and centralises
 * the formatting choice so we can switch encoding (e.g. NDJSON, CRLF for
 * Windows pipes) in one place if it ever becomes necessary.
 *
 * stdout vs console.log: stdout.write keeps machine output one line per
 * payload; console.log appends an extra newline that confuses jq pipes.
 * The helpers below preserve the existing terminator semantics literally.
 */

/** Emit a value as a single line of compact JSON on stdout. Use when an
 *  external agent will pipe the output through jq or parse line-by-line. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

/** Emit a value as pretty-printed JSON on stdout (2-space indent). Use when
 *  the output is also meant to be human-readable (e.g. `tools describe`). */
export function printJsonPretty(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/**
 * Print either a JSON payload or a human-readable line, picked by the
 * `--json` flag the calling command exposes. The human side may be a string
 * or a function — the function form lets the caller defer formatting until
 * we actually need the human output, useful when the formatter is expensive.
 */
export function printJsonOrHuman(
  json: boolean | undefined,
  jsonValue: unknown,
  human: string | (() => string),
  opts: { pretty?: boolean } = {},
): void {
  if (json) {
    if (opts.pretty) printJsonPretty(jsonValue);
    else printJson(jsonValue);
    return;
  }
  console.log(typeof human === 'function' ? human() : human);
}
