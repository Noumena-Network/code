import { appendFile, mkdir, stat, symlink, unlink } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'

import { type BufferedWriter, createBufferedWriter } from './bufferedWriter.js'
import { registerCleanup } from './cleanupRegistry.js'
import {
  type DebugFilter,
  parseDebugFilter,
  shouldShowDebugMessage,
} from './debugFilter.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { writeToStderr } from './process.js'
import { jsonStringify } from './slowOperations.js'
import { isInternalBuild } from 'src/capabilities/static.js'

export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}
const DEFAULT_DEBUG_LOG_MAX_BYTES = 64 * 1024 * 1024
const DEBUG_LOG_CAP_SENTINEL =
  'Debug log cap reached; further debug logs are suppressed for this session.'

type DebugLogBudgetState = {
  initialized: boolean
  bytes: number
  capped: boolean
}

const debugLogBudgetByPath = new Map<string, DebugLogBudgetState>()

export const getDebugLogMaxBytes = memoize((): number => {
  const raw =
    process.env.NCODE_DEBUG_LOG_MAX_BYTES ??
    process.env.CLAUDE_CODE_DEBUG_LOG_MAX_BYTES
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_DEBUG_LOG_MAX_BYTES
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_DEBUG_LOG_MAX_BYTES
  }
  return Math.floor(parsed)
})

function getDebugLogBudgetState(path: string): DebugLogBudgetState {
  let state = debugLogBudgetByPath.get(path)
  if (!state) {
    state = { initialized: false, bytes: 0, capped: false }
    debugLogBudgetByPath.set(path, state)
  }
  return state
}

function applyDebugLogBudget(
  path: string,
  content: string,
  existingBytes: number,
): string | null {
  const maxBytes = getDebugLogMaxBytes()
  const state = getDebugLogBudgetState(path)
  if (!state.initialized) {
    state.bytes = existingBytes
    state.initialized = true
  }
  if (state.capped) {
    return null
  }
  if (state.bytes + content.length <= maxBytes) {
    state.bytes += content.length
    return content
  }

  let preserved = ''
  const lines = content.match(/[^\n]*\n|[^\n]+/g) ?? []
  for (const line of lines) {
    if (state.bytes + preserved.length + line.length > maxBytes) {
      break
    }
    preserved += line
  }

  state.capped = true
  const sentinel = `${new Date().toISOString()} [WARN] ${DEBUG_LOG_CAP_SENTINEL} maxBytes=${maxBytes} path=${path}\n`
  state.bytes += preserved.length + sentinel.length
  return preserved + sentinel
}

async function applyDebugLogBudgetAsync(
  path: string,
  content: string,
): Promise<string | null> {
  const state = getDebugLogBudgetState(path)
  let existingBytes = state.bytes
  if (!state.initialized) {
    try {
      existingBytes = (await stat(path)).size
    } catch {
      existingBytes = 0
    }
  }
  return applyDebugLogBudget(path, content, existingBytes)
}

function applyDebugLogBudgetSync(path: string, content: string): string | null {
  const state = getDebugLogBudgetState(path)
  let existingBytes = state.bytes
  if (!state.initialized) {
    try {
      existingBytes = getFsImplementation().statSync(path).size
    } catch {
      existingBytes = 0
    }
  }
  return applyDebugLogBudget(path, content, existingBytes)
}

export function resetDebugLoggingForTesting(): void {
  debugWriter?.dispose()
  debugWriter = null
  pendingWrite = Promise.resolve()
  debugLoggingUnavailable = false
  debugLoggingUnavailableLogged = false
  runtimeDebugEnabled = false
  debugLogBudgetByPath.clear()
  getDebugLogMaxBytes.cache.clear?.()
  getMinDebugLogLevel.cache.clear?.()
  isDebugMode.cache.clear?.()
  getDebugFilePath.cache.clear?.()
  getDebugFilter.cache.clear?.()
  isDebugToStdErr.cache.clear?.()
  updateLatestDebugLogSymlink.cache.clear?.()
}

/**
 * Minimum log level to include in debug output. Defaults to 'debug', which
 * filters out 'verbose' messages. Set CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose to
 * include high-volume diagnostics (e.g. full statusLine command, shell, cwd,
 * stdout/stderr) that would otherwise drown out useful debug output.
 */
export const getMinDebugLogLevel = memoize((): DebugLogLevel => {
  const raw = process.env.CLAUDE_CODE_DEBUG_LOG_LEVEL?.toLowerCase().trim()
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as DebugLogLevel
  }
  return 'debug'
})

let runtimeDebugEnabled = false

export const isDebugMode = memoize((): boolean => {
  return (
    runtimeDebugEnabled ||
    isEnvTruthy(process.env.DEBUG) ||
    isEnvTruthy(process.env.DEBUG_SDK) ||
    process.argv.includes('--debug') ||
    process.argv.includes('-d') ||
    isDebugToStdErr() ||
    // Also check for --debug=pattern syntax
    process.argv.some(arg => arg.startsWith('--debug=')) ||
    // --debug-file implicitly enables debug mode
    getDebugFilePath() !== null
  )
})

/**
 * Enables debug logging mid-session (e.g. via /debug). Non-ants don't write
 * debug logs by default, so this lets them start capturing without restarting
 * with --debug. Returns true if logging was already active.
 */
export function enableDebugLogging(): boolean {
  const wasActive = isDebugMode() || isInternalBuild()
  runtimeDebugEnabled = true
  isDebugMode.cache.clear?.()
  return wasActive
}

// Extract and parse debug filter from command line arguments
// Exported for testing purposes
export const getDebugFilter = memoize((): DebugFilter | null => {
  // Look for --debug=pattern in argv
  const debugArg = process.argv.find(arg => arg.startsWith('--debug='))
  if (!debugArg) {
    return null
  }

  // Extract the pattern after the equals sign
  const filterPattern = debugArg.substring('--debug='.length)
  return parseDebugFilter(filterPattern)
})

export const isDebugToStdErr = memoize((): boolean => {
  return (
    process.argv.includes('--debug-to-stderr') || process.argv.includes('-d2e')
  )
})

export const getDebugFilePath = memoize((): string | null => {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i]!
    if (arg.startsWith('--debug-file=')) {
      return arg.substring('--debug-file='.length)
    }
    if (arg === '--debug-file' && i + 1 < process.argv.length) {
      return process.argv[i + 1]!
    }
  }
  return null
})

function shouldLogDebugMessage(message: string): boolean {
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) {
    return false
  }

  // Non-ants only write debug logs when debug mode is active (via --debug at
  // startup or /debug mid-session). Ants always log for /share, bug reports.
  if (!isInternalBuild() && !isDebugMode()) {
    return false
  }

  if (
    typeof process === 'undefined' ||
    typeof process.versions === 'undefined' ||
    typeof process.versions.node === 'undefined'
  ) {
    return false
  }

  const filter = getDebugFilter()
  return shouldShowDebugMessage(message, filter)
}

let hasFormattedOutput = false
export function setHasFormattedOutput(value: boolean): void {
  hasFormattedOutput = value
}
export function getHasFormattedOutput(): boolean {
  return hasFormattedOutput
}

let debugWriter: BufferedWriter | null = null
let pendingWrite: Promise<void> = Promise.resolve()
let debugLoggingUnavailable = false
let debugLoggingUnavailableLogged = false

function markDebugLoggingUnavailable(error: unknown): void {
  debugLoggingUnavailable = true
  if (debugLoggingUnavailableLogged) {
    return
  }
  debugLoggingUnavailableLogged = true
  if (isDebugToStdErr()) {
    writeToStderr(
      `${new Date().toISOString()} [WARN] Debug logging disabled: ${errorMessage(error)}\n`,
    )
  }
}

// Module-level so .bind captures only its explicit args, not the
// writeFn closure's parent scope (Jarred, #22257).
async function appendAsync(
  needMkdir: boolean,
  dir: string,
  path: string,
  content: string,
): Promise<void> {
  if (debugLoggingUnavailable) {
    return
  }
  if (needMkdir) {
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      if (isFsInaccessible(error)) {
        markDebugLoggingUnavailable(error)
        return
      }
    }
  }
  try {
    const budgetedContent = await applyDebugLogBudgetAsync(path, content)
    if (budgetedContent === null) {
      return
    }
    await appendFile(path, budgetedContent)
    void updateLatestDebugLogSymlink()
  } catch (error) {
    if (isFsInaccessible(error)) {
      markDebugLoggingUnavailable(error)
      return
    }
    throw error
  }
}

function noop(): void {}

function getDebugWriter(): BufferedWriter {
  if (!debugWriter) {
    let ensuredDir: string | null = null
    debugWriter = createBufferedWriter({
      writeFn: content => {
        if (debugLoggingUnavailable) {
          return
        }
        const path = getDebugLogPath()
        const dir = dirname(path)
        const needMkdir = ensuredDir !== dir
        ensuredDir = dir
        if (isDebugMode()) {
          // immediateMode: must stay sync. Async writes are lost on direct
          // process.exit() and keep the event loop alive in beforeExit
          // handlers (infinite loop with Perfetto tracing). See #22257.
          if (needMkdir) {
            try {
              getFsImplementation().mkdirSync(dir)
            } catch (error) {
              if (isFsInaccessible(error)) {
                markDebugLoggingUnavailable(error)
                return
              }
              // Directory already exists
            }
          }
          try {
            const budgetedContent = applyDebugLogBudgetSync(path, content)
            if (budgetedContent === null) {
              return
            }
            getFsImplementation().appendFileSync(path, budgetedContent)
            void updateLatestDebugLogSymlink()
          } catch (error) {
            if (isFsInaccessible(error)) {
              markDebugLoggingUnavailable(error)
              return
            }
            throw error
          }
          return
        }
        // Buffered path (ants without --debug): flushes ~1/sec so chain
        // depth stays ~1. .bind over a closure so only the bound args are
        // retained, not this scope.
        pendingWrite = pendingWrite
          .then(appendAsync.bind(null, needMkdir, dir, path, content))
          .catch(noop)
      },
      flushIntervalMs: 1000,
      maxBufferSize: 100,
      immediateMode: isDebugMode(),
    })
    registerCleanup(async () => {
      debugWriter?.dispose()
      await pendingWrite
    })
  }
  return debugWriter
}

export async function flushDebugLogs(): Promise<void> {
  debugWriter?.flush()
  await pendingWrite
}

export function logForDebugging(
  message: string,
  { level }: { level: DebugLogLevel } = {
    level: 'debug',
  },
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) {
    return
  }
  if (!shouldLogDebugMessage(message)) {
    return
  }

  // Multiline messages break the jsonl output format, so make any multiline messages JSON.
  if (hasFormattedOutput && message.includes('\n')) {
    message = jsonStringify(message)
  }
  const timestamp = new Date().toISOString()
  const output = `${timestamp} [${level.toUpperCase()}] ${message.trim()}\n`
  if (isDebugToStdErr()) {
    writeToStderr(output)
    return
  }

  getDebugWriter().write(output)
}

export function getDebugLogPath(): string {
  return (
    getDebugFilePath() ??
    process.env.CLAUDE_CODE_DEBUG_LOGS_DIR ??
    join(getClaudeConfigHomeDir(), 'debug', `${getSessionId()}.txt`)
  )
}

/**
 * Updates the latest debug log symlink to point to the current debug log file.
 * Creates or updates a symlink at ~/.ncode/debug/latest
 */
const updateLatestDebugLogSymlink = memoize(async (): Promise<void> => {
  try {
    const debugLogPath = getDebugLogPath()
    const debugLogsDir = dirname(debugLogPath)
    const latestSymlinkPath = join(debugLogsDir, 'latest')

    await unlink(latestSymlinkPath).catch(() => {})
    await symlink(debugLogPath, latestSymlinkPath)
  } catch {
    // Silently fail if symlink creation fails
  }
})

/**
 * Logs errors for Ants only, always visible in production.
 */
export function logAntError(context: string, error: unknown): void {
  if (!isInternalBuild()) {
    return
  }

  if (error instanceof Error && error.stack) {
    logForDebugging(`[ANT-ONLY] ${context} stack trace:\n${error.stack}`, {
      level: 'error',
    })
  }
}
