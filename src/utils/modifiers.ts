export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

let prewarmed = false

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  // Load module in background
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prewarm } = require('modifiers-napi') as { prewarm: () => void }
    prewarm()
  } catch {
    // Ignore errors during prewarm
  }
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 *
 * `modifiers-napi` is a reserved stub (`0.0.1`, no exports) on public npm. When
 * the native module is unavailable we fail closed: report the modifier as not
 * pressed. That disables Apple_Terminal's best-effort Shift+Enter newline
 * detection (a nicety) without breaking Enter submit (which the stub otherwise
 * crashes on every keystroke).
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  const { isModifierPressed: nativeIsModifierPressed } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('modifiers-napi') as {
      isModifierPressed?: (m: string) => boolean
    }
  if (typeof nativeIsModifierPressed !== 'function') {
    return false
  }
  return nativeIsModifierPressed(modifier)
}
