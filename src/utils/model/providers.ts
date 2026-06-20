import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'
import { getSettingsWithErrors } from '../settings/settings.js'
import type { UserProvider } from '../settings/types.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

const FIRST_PARTY_NOUMENA_HOSTS = [
  'api.noumena.com',
  'code.noumena.com',
]
const FIRST_PARTY_ANTHROPIC_HOSTS = ['api.anthropic.com']

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const baseUrl = value?.trim()
  return baseUrl && baseUrl.length > 0 ? baseUrl : undefined
}

export function getNoumenaBaseUrl(): string | undefined {
  return normalizeBaseUrl(process.env.NOUMENA_BASE_URL)
}

export function getAnthropicBaseUrl(): string | undefined {
  return normalizeBaseUrl(process.env.ANTHROPIC_BASE_URL)
}

export function getFirstPartyBaseUrlOverride(): string | undefined {
  return getNoumenaBaseUrl() ?? getAnthropicBaseUrl()
}

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

function getAllowedFirstPartyHosts(): string[] {
  const allowedHosts = [
    ...FIRST_PARTY_NOUMENA_HOSTS,
    ...FIRST_PARTY_ANTHROPIC_HOSTS,
  ]
  if (process.env.USER_TYPE === 'ant') {
    allowedHosts.push('api-staging.anthropic.com')
  }
  return allowedHosts
}

export function isFirstPartyBaseUrlValue(
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl) {
    return false
  }
  try {
    const host = new URL(baseUrl).host
    return getAllowedFirstPartyHosts().includes(host)
  } catch {
    return false
  }
}

/**
 * Check whether the configured first-party base URL override still points at
 * a Noumena-owned host. During migration, we also treat legacy Anthropic-owned
 * first-party hosts as trusted so behavior remains stable until the rest of the
 * stack is repointed.
 *
 * Returns true when no explicit override is set, because the default OAuth
 * BASE_API_URL path is still considered first-party.
 */
export function isFirstPartyNoumenaBaseUrl(): boolean {
  const baseUrl = getFirstPartyBaseUrlOverride()
  if (!baseUrl) {
    return true
  }
  return isFirstPartyBaseUrlValue(baseUrl)
}

/**
 * Temporary compatibility alias while the rest of `code/` is migrated away
 * from Anthropic-specific naming.
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  return isFirstPartyNoumenaBaseUrl()
}

// ---------------------------------------------------------------------------
// BYOK provider registry (see docs/design/PROVIDERS_REGISTRY.md)
//
// Declares one or more OpenAI-compatible BYOK endpoints in
// .ncode/settings.json. Each declared provider contributes entries to the
// /model picker, and a model ID resolves back to its owning provider at
// request time. This is the sole BYOK path — there is no env-var fallback.
// ---------------------------------------------------------------------------

/**
 * Load the operator's BYOK provider registry from .ncode/settings.json.
 * Readonly. Returns [] when settings are absent, the providers key is
 * missing, or schema validation fails. Schema validation (UserProviderSchema
 * in settings/types.ts) guarantees base_url, api_key_env, and >=1 model per
 * entry, so no defensive checks here.
 */
export function loadUserProviders(): readonly UserProvider[] {
  const { settings, errors } = getSettingsWithErrors()
  if (errors.length > 0 || !settings.providers) {
    return []
  }
  return settings.providers
}

/**
 * Find the registry entry that declares the given model ID. Returns the first
 * match — operators should disambiguate duplicate IDs across providers by
 * using distinct model IDs.
 */
export function findRegistryEntryForModel(
  modelId: string,
): UserProvider | undefined {
  for (const provider of loadUserProviders()) {
    if (provider.models.some(m => m.id === modelId)) {
      return provider
    }
  }
  return undefined
}

/**
 * Return the { baseURL, apiKey } pair for the given model ID. Resolution
 * order:
 *   1. Registry lookup (does any declared entry expose this model ID?)
 *      → return that entry's base_url + api_key (read lazily from env var)
 *   2. undefined (caller treats as firstParty/Anthropic-native path)
 *
 * Throws if the registry entry's api_key_env points at an unset env var —
 * loud failure preferred over silent unauthorized requests.
 *
 * The API key is read lazily on each call, so key rotations take effect
 * without restarting ncode.
 */
export function getActiveProviderEndpointForModel(
  modelId: string | undefined,
): { baseURL: string; apiKey: string } | undefined {
  const entry = modelId ? findRegistryEntryForModel(modelId) : undefined
  if (!entry) return undefined
  const apiKey = process.env[entry.api_key_env]?.trim()
  if (!apiKey) {
    throw new Error(
      `Provider "${entry.name}" requires API key in env var ` +
        `"${entry.api_key_env}" but it is unset or empty. Set the ` +
        `env var and retry.`,
    )
  }
  return { baseURL: entry.base_url, apiKey }
}
