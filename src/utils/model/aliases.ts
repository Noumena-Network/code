import {
  NCODE_MANAGED_MODEL_ALIASES,
  resolveNCodeManagedModel,
} from './ncodeModels.js'

const LEGACY_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'opusplan'] as const

export const MODEL_ALIASES = [
  ...NCODE_MANAGED_MODEL_ALIASES,
  ...LEGACY_MODEL_ALIASES,
] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  const normalized = modelInput.trim().toLowerCase()
  return (
    resolveNCodeManagedModel(normalized) !== undefined ||
    (LEGACY_MODEL_ALIASES as readonly string[]).includes(normalized)
  )
}

/**
 * Bare model family aliases that act as wildcards in the availableModels allowlist.
 * There are no longer family aliases; only Noumena-managed model aliases.
 */
export const MODEL_FAMILY_ALIASES: readonly string[] = []

export function isModelFamilyAlias(_model: string): boolean {
  return false
}

export { LEGACY_MODEL_ALIASES }
