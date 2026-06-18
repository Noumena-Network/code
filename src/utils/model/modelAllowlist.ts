import { getSettings_DEPRECATED } from '../settings/settings.js'
import { isModelAlias } from './aliases.js'
import { parseUserSpecifiedModel } from './model.js'
import { resolveOverriddenModel } from './modelStrings.js'

/**
 * Check if a model is allowed by the availableModels allowlist in settings.
 * If availableModels is not set, all models are allowed.
 *
 * Matching:
 * 1. Full model IDs or aliases match exactly.
 * 2. If the model is an alias, its resolved canonical ID is also checked.
 */
export function isModelAllowed(model: string): boolean {
  const settings = getSettings_DEPRECATED() || {}
  const { availableModels } = settings
  if (!availableModels) {
    return true // No restrictions
  }
  if (availableModels.length === 0) {
    return false // Empty allowlist blocks all user-specified models
  }

  const resolvedModel = resolveOverriddenModel(model)
  const normalizedModel = resolvedModel.trim().toLowerCase()
  const normalizedAllowlist = availableModels.map(m => m.trim().toLowerCase())

  // Direct match (alias-to-alias or full-name-to-full-name)
  if (normalizedAllowlist.includes(normalizedModel)) {
    return true
  }

  // For model aliases, resolve and check if the resolved name is allowed.
  if (isModelAlias(normalizedModel)) {
    const resolved = parseUserSpecifiedModel(normalizedModel).toLowerCase()
    if (normalizedAllowlist.includes(resolved)) {
      return true
    }
  }

  return false
}
