import { getSettings_DEPRECATED } from '../settings/settings.js'
import { LEGACY_MODEL_ALIASES, isModelAlias } from './aliases.js'
import { parseUserSpecifiedModel } from './model.js'
import {
  KIMI_2_7_CODER_MODEL,
  resolveNCodeManagedModel,
} from './ncodeModels.js'
import { resolveOverriddenModel } from './modelStrings.js'

const LEGACY_MODEL_FAMILY_ALIASES = new Set(LEGACY_MODEL_ALIASES)

function isLegacyAllowlistEntry(entry: string): boolean {
  const lower = entry.toLowerCase()
  if (LEGACY_MODEL_FAMILY_ALIASES.has(lower)) {
    return true
  }
  for (const family of LEGACY_MODEL_FAMILY_ALIASES) {
    if (lower.startsWith(`${family}-`)) {
      return true
    }
  }
  return lower.startsWith('claude-') || lower.startsWith('anthropic.')
}

function resolvesToCurrentNoumenaModel(model: string): boolean {
  const resolved = parseUserSpecifiedModel(model)
  const ncodeModel = resolveNCodeManagedModel(resolved)
  return ncodeModel?.model === KIMI_2_7_CODER_MODEL
}

/**
 * Check if a model is allowed by the availableModels allowlist in settings.
 * If availableModels is not set, all models are allowed.
 *
 * Matching:
 * 1. Full model IDs or aliases match exactly.
 * 2. If the model is an alias, its resolved canonical ID is also checked.
 * 3. Legacy Anthropic family aliases (sonnet/opus/haiku), version prefixes,
 *    and full model IDs are accepted as aliases for the managed Kimi model
 *    during the one-release migration window.
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

  // Migration path: allowlists written for the old Anthropic model grid
  // continue to authorize the current Noumena-managed Kimi model.
  if (
    normalizedAllowlist.some(isLegacyAllowlistEntry) &&
    resolvesToCurrentNoumenaModel(resolvedModel)
  ) {
    return true
  }

  return false
}
