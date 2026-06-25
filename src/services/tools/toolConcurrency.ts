import type { Tool } from '../../Tool.js'

/**
 * Parse a tool's raw input and determine whether the tool is concurrency-safe
 * for that input (i.e. safe to run in parallel with other concurrency-safe
 * tools).
 *
 * Returns `false` when the tool is missing, the input fails schema validation,
 * or `tool.isConcurrencySafe` throws (e.g. due to shell-quote parse failure).
 * Failures are treated conservatively — a tool that can't be determined safe
 * is run exclusively.
 *
 * Shared by `toolOrchestration.runTools` and `StreamingToolExecutor` so the
 * partition/concurrency decision is computed in one place.
 */
export function isToolConcurrencySafe(
  tool: Tool | undefined,
  rawInput: unknown,
): boolean {
  if (!tool) return false
  const parsedInput = tool.inputSchema.safeParse(rawInput)
  if (!parsedInput.success) return false
  try {
    return Boolean(tool.isConcurrencySafe(parsedInput.data))
  } catch {
    // If isConcurrencySafe throws (e.g. due to shell-quote parse failure),
    // treat as not concurrency-safe to be conservative.
    return false
  }
}
