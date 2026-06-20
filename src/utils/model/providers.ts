import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'custom'

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

const NCODE_USE_CUSTOM_PROVIDER = 'NCODE_USE_CUSTOM_PROVIDER'
const NCODE_CUSTOM_PROVIDER_URL = 'NCODE_CUSTOM_PROVIDER_URL'
const NCODE_CUSTOM_PROVIDER_API_KEY = 'NCODE_CUSTOM_PROVIDER_API_KEY'

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : isCustomProviderEnabled()
          ? 'custom'
          : 'firstParty'
}

/**
 * Returns true when the operator has explicitly opted into the custom
 * provider via NCODE_USE_CUSTOM_PROVIDER. Does not validate credentials —
 * the credential check lives in inferenceClient where missing URL/key
 * produce a clear error rather than a silent fallthrough to firstParty.
 */
function isCustomProviderEnabled(): boolean {
  return isEnvTruthy(process.env[NCODE_USE_CUSTOM_PROVIDER])
}

/**
 * The OpenAI-compatible base URL configured for the custom provider
 * (e.g. https://api.deepseek.com). Returns undefined when not set or
 * empty.
 */
export function getCustomProviderBaseUrl(): string | undefined {
  return normalizeBaseUrl(process.env[NCODE_CUSTOM_PROVIDER_URL])
}

/**
 * The API key for the custom provider. Sent as Authorization: Bearer <key>
 * to the OpenAI-compatible endpoint. Returns undefined when not set or
 * empty.
 */
export function getCustomProviderApiKey(): string | undefined {
  return process.env[NCODE_CUSTOM_PROVIDER_API_KEY]?.trim() || undefined
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
