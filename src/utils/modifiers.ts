import { createRequire } from 'node:module'
import { logForDebugging } from './debug.js'

export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

const requireFn = createRequire(import.meta.url)

type ModifiersBinding = {
  prewarm?: () => void
  isModifierPressed?: (m: string) => boolean
}

let cachedBinding: ModifiersBinding | null | undefined
let prewarmed = false

function loadBinding(): ModifiersBinding | null {
  if (cachedBinding !== undefined) {
    return cachedBinding
  }
  try {
    cachedBinding = requireFn('modifiers-napi') as ModifiersBinding
  } catch (error) {
    logForDebugging(
      `[modifiers] modifiers-napi unavailable (platform=${process.platform}): ${error instanceof Error ? error.message : String(error)}`,
    )
    cachedBinding = null
  }
  return cachedBinding
}

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  const binding = loadBinding()
  binding?.prewarm?.()
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  const binding = loadBinding()
  return binding?.isModifierPressed?.(modifier) ?? false
}
