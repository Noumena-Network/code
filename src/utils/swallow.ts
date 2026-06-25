import { logForDebugging } from './debug.js'

/**
 * Fire-and-forget a promise without surfacing rejections as unhandledRejection.
 *
 * The error is logged at debug level with the provided context string so
 * failures are observable when debugging, but never propagate. Use this in
 * place of `void promise.catch(() => {})` so silent failures leave a trace.
 *
 * Returns nothing — callers should not await it. For promises whose result is
 * needed, use a regular try/catch.
 */
export function swallow<T>(
  promise: Promise<T>,
  context: string,
): void {
  void promise.then(
    () => {},
    error => {
      logForDebugging(`[swallow] ${context}: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}
