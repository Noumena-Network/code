// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { getModelCapability } from './model/modelCapabilities.js'
import { resolveNCodeManagedModel } from './model/ncodeModels.js'
import { isInternalBuild } from 'src/capabilities/static.js'

// Model context window size for legacy/unknown models
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by admins to disable 1M context for compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// No public Anthropic models remain; 1M context is supported by any
// Noumena-managed model when requested explicitly via the [1m] suffix.
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return resolveNCodeManagedModel(model) !== undefined
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable (ant-only)
  if (
    isInternalBuild() &&
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // [1m] suffix — explicit client-side opt-in
  if (has1mContext(model)) {
    return 1_000_000
  }

  const ncodeModel = resolveNCodeManagedModel(model)
  if (ncodeModel) {
    return ncodeModel.contextWindow
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }

  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(_model: string): boolean {
  return false
}

/**
 * Calculate context window usage percentage from token usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  const ncodeModel = resolveNCodeManagedModel(model)
  if (ncodeModel) {
    return {
      default: ncodeModel.defaultMaxTokens,
      upperLimit: ncodeModel.upperMaxTokensLimit,
    }
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    return {
      default: Math.min(MAX_OUTPUT_TOKENS_DEFAULT, cap.max_tokens),
      upperLimit: cap.max_tokens,
    }
  }

  return {
    default: MAX_OUTPUT_TOKENS_DEFAULT,
    upperLimit: MAX_OUTPUT_TOKENS_UPPER_LIMIT,
  }
}

/**
 * Returns the max thinking budget tokens for a given model.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
