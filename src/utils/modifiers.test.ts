import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { platform } from 'os'

const isDarwin = platform() === 'darwin'

describe('modifiers — modifiers-napi stub fail-closed', () => {
  let originalPlatform:PropertyDescriptor | undefined
  let requireMock: ReturnType<typeof mock>

  beforeEach(() => {
    // Stub require('modifiers-napi') to return the reservation-stub shape
    // (no exports) that's published on public npm as modifiers-napi@0.0.1.
    requireMock = mock((moduleName: string) => {
      if (moduleName !== 'modifiers-napi') {
        throw new Error(`unexpected require: ${moduleName}`)
      }
      return {} as { isModifierPressed?: (m: string) => boolean }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).require = requireMock
  })

  afterEach(() => {
    mock.restore()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).require
  })

  test('isModifierPressed returns false instead of throwing when the native export is missing', async () => {
    const originalPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!isDarwin) {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    }
    try {
      const { isModifierPressed } = await import('./modifiers.js')
      // Must not throw TypeError. Stub has no isModifierPressed export, so the
      // guard path runs and yields false (modifier reported as not pressed).
      expect(() => isModifierPressed('shift')).not.toThrow()
      expect(isModifierPressed('shift')).toBe(false)
      expect(isModifierPressed('command')).toBe(false)
    } finally {
      if (originalPlatformDesc) {
        Object.defineProperty(process, 'platform', originalPlatformDesc)
      }
    }
  })

  test('isModifierPressed returns false on non-darwin platforms regardless of stub', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const { isModifierPressed } = await import('./modifiers.js')
      expect(isModifierPressed('shift')).toBe(false)
      // The stub require() must not have been consulted on non-darwin.
      expect(requireMock).toHaveBeenCalledTimes(0)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})