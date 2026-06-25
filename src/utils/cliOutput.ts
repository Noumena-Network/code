/**
 * Intentional stdout/stderr output helpers for CLI subcommand handlers.
 *
 * The `noConsole` lint rule flags `console.log`/`console.warn`/`console.error`
 * to catch accidental logging in library code (which would corrupt Ink's
 * terminal output). Subcommand handlers (mcp, plugin, auth, bridge, etc.) that
 * print user-facing CLI output must use these helpers instead of bare
 * `console.*` so the intent is explicit and the lint suppression lives in one
 * place rather than at 248 scattered `biome-ignore` comments.
 *
 * These are thin pass-throughs to `process.stdout`/`process.stderr` — they do
 * NOT go through Ink's `patchConsole` and are safe to call before/after the
 * React tree is mounted. Unlike `cliError`/`cliOk` in `src/cli/exit.ts`, these
 * do NOT exit the process — use them for intermediate output (tables, help,
 * warnings) and reserve `cliError`/`cliOk` for terminal exit-and-print paths.
 */

/** Write a line to stdout. Use for user-facing CLI output (help, tables, results). */
export function cliPrint(...args: unknown[]): void {
  // biome-ignore lint/suspicious/noConsole:: intentional CLI stdout output
  console.log(...args)
}

/** Write a line to stderr. Use for warnings that should not pollute stdout pipes. */
export function cliPrintWarn(...args: unknown[]): void {
  // biome-ignore lint/suspicious/noConsole:: intentional CLI stderr output
  console.warn(...args)
}

/** Write a line to stderr. Use for errors that should not pollute stdout pipes. */
export function cliPrintError(...args: unknown[]): void {
  // biome-ignore lint/suspicious/noConsole:: intentional CLI stderr output
  console.error(...args)
}
