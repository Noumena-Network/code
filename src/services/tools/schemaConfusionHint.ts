/**
 * Detects tool-call schema confusion in the {Bash, Grep, Glob, Read,
 * WebFetch, Write} cluster and returns a targeted, actionable hint
 * appended to the standard Zod validation error.
 *
 * Background: GLM-5.2 (and likely other OpenAI-compatible models) emit
 * calls to one tool with the parameter schema of a sibling tool. Example:
 * `Bash({ file_path: '/x' })` — where `file_path` belongs to Read, not
 * Bash. The raw Zod error ("required parameter `command` is missing;
 * unexpected parameter `file_path` was provided") names the problem but
 * does not name the fix, so the model retries by guessing. This hint
 * names both.
 *
 * Confirmed shape catalog:
 *   schema-confusion:
 *     Bash({ file_path[, limit] })               → Read
 *     Bash({ pattern, path[, output_mode] })     → Grep
 *     Bash({ pattern })                          → Glob
 *     Grep({ command[, description] })           → Bash
 *     Read({ command[, description] })           → Bash
 *     Read({ pattern })                          → Glob
 *     Grep({ pattern = <glob-looking string> })  → Glob
 *   Extension:
 *     WebFetch({ file_path[, limit, offset, pages] }) → Read
 *     Write({ file_path, limit/offset/pages })        → Read
 *     Write({ file_path, content })                   → null (well-formed)
 *     Write({ file_path })                            → null (ambiguous)
 *     Bash({ file_path, content })                    → Write (content anchors)
 *
 * The hint is appended to the standard `formatZodValidationError`
 * output in toolExecution.ts; it does not silently reroute the call.
 * Rerouting would create transcript inconsistency (a Bash call turning
 * into a Read result under the same tool_use_id). The hint keeps the
 * transcript clean and lets the model self-correct on the next turn.
 *
 * Returns null when no confusion pattern fires so callers can write
 * `if (hint) errorContent += hint` without further condition.
 */

// Set of tool names subject to schema-confusion hinting. Originally the
// search-tool cluster {Bash, Grep, Glob, Read} (schema-confusion, 2026-06-20). Extended
// to WebFetch and Write after GLM-5.2 reports showed the model leaking
// Read's `file_path` (and Read's `limit`/`offset`) onto WebFetch and Write
// repeatedly without recovering, because the hint never fired for those
// called tools.
const SEARCH_TOOL_NAMES = new Set(['Bash', 'Grep', 'Glob', 'Read', 'WebFetch', 'Write'])

// Read-only optional params. Used to disambiguate the Write/Read file_path
// collision: only Read accepts these as input, so their presence alongside
// file_path on a Write call is a strong signal the model meant Read.
const READ_ONLY_OPTIONALS = new Set(['limit', 'offset', 'pages'])

// Parameter-scorecard per tool in the cluster. The matcher uses these
// tables to (a) decide whether the model's input keys belong to a
// different sibling tool, and (b) hand the model the parameter name
// it should actually use on its originally-named tool.
//
// `keyword`: required/marketing parameter that uniquely identifies
// the tool (used for high-confidence detection).
// `optional`: optional params that, when present alongside the
// keyword, reinforce the diagnosis but don't diagnose alone.
type ToolParamSignature = {
  keyword: string
  optional: ReadonlySet<string>
}

const SIGNATURES: Record<string, ToolParamSignature> = {
  Bash: {
    keyword: 'command',
    optional: new Set([
      'description',
      'timeout',
      'run_in_background',
      'dangerouslyDisableSandbox',
    ]),
  },
  Read: {
    keyword: 'file_path',
    optional: new Set(['limit', 'offset', 'pages']),
  },
  Grep: {
    keyword: 'pattern',
    optional: new Set([
      'path',
      'output_mode',
      'glob',
      'type',
      'multiline',
      'head_limit',
      'offset',
      'context',
      '-i',
      '-n',
      '-A',
      '-B',
      '-C',
    ]),
  },
  // Glob shares `pattern` with Grep. Disambiguation is content-based:
  // a pattern with path-like or glob-shaped chars (no regex-isms, no
  // pipe alternation) when emitted alone is treated as Glob intent.
  Glob: {
    keyword: 'pattern',
    optional: new Set(['path', 'output_mode']),
  },
  // WebFetch's url/prompt are unique — no other tool in the cluster
  // accepts them. WebFetch calls that leak Read's file_path (with or
  // without Read's optionals) therefore route cleanly to Read.
  WebFetch: {
    keyword: 'url',
    optional: new Set(['prompt']),
  },
  // Write: `content` is Write-unique — no other tool in the cluster
  // accepts it. Making `content` Write's keyword (not `file_path`)
  // resolves the Write/Read `file_path` collision at the target side:
  // any input with `content` present cleanly anchors Write intent,
  // regardless of whether Read is in the sibling registry. `file_path`
  // becomes optional because Write does accept it as a required field
  // in the actual Zod schema, but as a leak-detection signal it is
  // shared with Read and cannot anchor Write intent alone.
  Write: {
    keyword: 'content',
    optional: new Set(['file_path']),
  },
}

// Returns true if a pattern string looks like a file glob rather than
// a regex (e.g. "*.ts", "src/**/\*.tsx", "foo/*.md") vs an actual
// regex (e.g. "foo|bar", "\\bword\\b", "^a.*z$").
function looksLikeGlob(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false
  // Glob-only signatures: contains `*` or `?` or `[...]` but no regex
  // alternation (`|`) or common anchors/quantifiers that Grep regexes
  // rely on. We deliberately keep this conservative — when in doubt,
  // we do not classify a pattern as glob (returns false) so the model
  // keeps the Grep intent and the model-side retry isn't misdirected.
  if (!/[*?]/.test(pattern)) return false
  if (/[|]/.test(pattern)) return false
  if (/\\\b|\\b|\\\d|\^\(|\$\)/.test(pattern)) return false
  // Path-style glob: leading slash or ./ or contains directory separators
  if (pattern.includes('/') || pattern.startsWith('.') ) return true
  // Bare glob like "*.ts" with no path
  return true
}

/**
 * Shared leak-detection core. Returns the sibling tool whose signature
 * best matches the input, or null when no leak is detected. Called by
 * both the model-facing hint string (buildSchemaConfusionHint) and the
 * structured telemetry inference (inferSchemaLeakSource) so they cannot
 * drift apart — a single source of truth for what counts as a schema
 * leak and which sibling the input points at.
 *
 * Returns null when:
 *   - called tool is outside SEARCH_TOOL_NAMES
 *   - input is empty
 *   - called tool's own keyword is present (well-formed call)
 *   - Write is called without `content` and without Read-only optionals
 *     (ambiguous: could be Write missing `content`, could be Read
 *     leaking `file_path` alone)
 *   - no sibling signature matches the input keys cleanly
 *
 * Does NOT handle the Grep-with-glob-looking-pattern special case —
 * that is a misuse warning (own keyword present), not a leak, and is
 * handled by buildSchemaConfusionHint directly before calling this.
 */
type SchemaLeakMatch = {
  target: string
  matchedParams: string[]
}

function matchSchemaLeakTarget(
  toolName: string,
  input: { [key: string]: unknown },
  siblingToolNames: readonly string[],
): SchemaLeakMatch | null {
  if (!SEARCH_TOOL_NAMES.has(toolName)) return null
  const inputKeys = Object.keys(input)
  if (inputKeys.length === 0) return null

  const availableTools = new Set(siblingToolNames)
  const calledSignature = SIGNATURES[toolName]
  let ownKeywordPresent = inputKeys.includes(calledSignature.keyword)

  // Write/Read file_path collision override (called side). With Write's
  // keyword set to `content`, `ownKeywordPresent` is true iff `content`
  // is in the input. When `content` is absent, we must distinguish:
  //   - A Read-only optional (limit/offset/pages) present → the model
  //     is leaking Read. `ownKeywordPresent` is already false (no
  //     content), so the sibling search below considers Read. No state
  //     to mutate.
  //   - No Read-only optional present → ambiguous: could be Write
  //     missing `content`, could be Read leaking `file_path` alone.
  //     Cannot disambiguate; return null and let the bare Zod error
  //     surface the missing `content` requirement.
  if (toolName === 'Write' && !inputKeys.includes('content')) {
    const hasReadOptional = inputKeys.some(k => READ_ONLY_OPTIONALS.has(k))
    if (!hasReadOptional) {
      return null
    }
  }

  // If the called tool's own keyword is present, the call is well-formed
  // for that tool — no leak to report.
  if (ownKeywordPresent) return null

  let bestMatch: SchemaLeakMatch | null = null

  for (const targetName of SEARCH_TOOL_NAMES) {
    if (targetName === toolName) continue
    if (!availableTools.has(targetName)) continue

    const signature = SIGNATURES[targetName]
    if (!inputKeys.includes(signature.keyword)) continue

    // Disambiguate the Grep/Glob pattern-keyword collision.
    if (targetName === 'Grep' || targetName === 'Glob') {
      if (signature.keyword === 'pattern') {
        const patternValue = input['pattern']
        // Skip a sibling whose keyword matches but whose value shape
        // doesn't fit. We only emit a hint for the sibling that best
        // explains the input.
        if (targetName === 'Glob' && !looksLikeGlob(patternValue)) {
          // If Glob's pattern looks like a regex, skip Glob.
          continue
        }
        if (
          targetName === 'Grep' &&
          looksLikeGlob(patternValue) &&
          // If pattern looks like a glob and there are no Grep-only
          // optionals present, treat as Glob intent.
          !inputKeys.some(k => SIGNATURES.Grep.optional.has(k))
        ) {
          continue
        }
      }
    }

    // Verify all input keys are either the target's keyword or one
    // of its optional params. Stray params weaken the match.
    const knownTargetParams = new Set([signature.keyword, ...signature.optional])
    const allKnown = inputKeys.every(k => knownTargetParams.has(k))
    if (!allKnown) continue

    const matchedParams = inputKeys.filter(
      k => k === signature.keyword || signature.optional.has(k),
    )
    if (!bestMatch || matchedParams.length > bestMatch.matchedParams.length) {
      bestMatch = { target: targetName, matchedParams }
    }
  }

  return bestMatch
}

/**
 * Constructs the confusion hint string. Returns null when no recognized
 * pattern fires, when the tool is not in the search cluster,
 * when the input is empty, or when the sibling tool the input points
 * at is not actually available in the registry (the model can't be
 * told to call a tool it doesn't have).
 */
export function buildSchemaConfusionHint(
  toolName: string,
  input: { [key: string]: unknown },
  siblingToolNames: readonly string[],
): string | null {
  // Grep-as-Glob special case: own keyword (pattern) is present, but a
  // bare glob-looking pattern with no Grep-specific optionals means the
  // model almost certainly meant Glob. File globs are not valid Grep
  // regex syntax and Grep would timeout or error. This is a misuse
  // warning, not a schema leak, so it is checked before the shared
  // leak matcher (which returns null when the called tool's own keyword
  // is present).
  if (
    toolName === 'Grep' &&
    siblingToolNames.includes('Glob') &&
    Object.keys(input).length === 1 &&
    typeof input['pattern'] === 'string' &&
    looksLikeGlob(input['pattern'])
  ) {
    return (
      ` Hint: \`${input['pattern']}\` looks like a file glob, not a ` +
      `regex. Call \`Glob\` with \`pattern\` instead of \`Grep\`.`
    )
  }

  const match = matchSchemaLeakTarget(toolName, input, siblingToolNames)
  if (!match) return null

  const { target, matchedParams } = match
  const ownKeyword = SIGNATURES[toolName].keyword
  const paramList = matchedParams.map(p => `\`${p}\``).join(', ')
  return (
    ` Hint: parameters ${paramList} belong to the \`${target}\` tool. ` +
    `Call \`${target}\` with those parameters instead, or supply \`${toolName}\`'s required \`${ownKeyword}\` parameter and retry.`
  )
}

/**
 * Structured inference result for telemetry. Same matching logic as
 * buildSchemaConfusionHint, but returns the structured fields instead of
 * the model-facing hint string. Used by the ncode_schema_leak_rejected
 * telemetry event so we can measure (a) leak frequency by tool family
 * and model, (b) how often the hint fires, and (c) which sibling the
 * input points at.
 *
 * Returns null when the called tool is outside SEARCH_TOOL_NAMES, when
 * input is empty, or when no sibling signature matches the input keys.
 * When the called tool's own keyword is present (well-formed call), also
 * returns null — that is not a leak.
 */
export type SchemaLeakInference = {
  /** Tool the input params actually belong to, e.g. "Read". */
  source_tool_inferred: string
  /** Input keys that matched the inferred sibling's signature. */
  stray_params: string[]
}

export function inferSchemaLeakSource(
  toolName: string,
  input: { [key: string]: unknown },
  siblingToolNames: readonly string[],
): SchemaLeakInference | null {
  const match = matchSchemaLeakTarget(toolName, input, siblingToolNames)
  if (!match) return null
  return {
    source_tool_inferred: match.target,
    stray_params: match.matchedParams,
  }
}