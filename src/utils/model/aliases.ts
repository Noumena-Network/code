import {
  NCODE_MANAGED_MODEL_ALIASES,
  resolveNCodeManagedModel,
} from './ncodeModels.js'

export const MODEL_ALIASES = [
  ...NCODE_MANAGED_MODEL_ALIASES,
] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  return resolveNCodeManagedModel(modelInput) !== undefined
}

/**
 * Bare model family aliases that act as wildcards in the availableModels allowlist.
 * There are no longer family aliases; only Noumena-managed model aliases.
 */
export const MODEL_FAMILY_ALIASES: readonly string[] = []

export function isModelFamilyAlias(_model: string): boolean {
  return false
}
