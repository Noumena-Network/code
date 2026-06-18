import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'

// Noumena is the only supported model/API provider in NCode. Legacy
// third-party cloud providers (Bedrock/Vertex/Foundry/BYOK) are no longer
// supported, so the runtime provider is always Noumena-first-party.
export type APIProvider = 'firstParty'

const FIRST_PARTY_NOUMENA_HOSTS = [
  'api.noumena.com',
  'code.noumena.com',
]

export const NOUMENA_API_PROVIDER: APIProvider = 'firstParty'

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const baseUrl = value?.trim()
  return baseUrl && baseUrl.length > 0 ? baseUrl : undefined
}

export function getNoumenaBaseUrl(): string | undefined {
  return normalizeBaseUrl(process.env.NOUMENA_BASE_URL)
}

export function getFirstPartyBaseUrlOverride(): string | undefined {
  return getNoumenaBaseUrl()
}

export function getAPIProvider(): APIProvider {
  return NOUMENA_API_PROVIDER
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

export function isFirstPartyBaseUrlValue(
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl) {
    return false
  }
  try {
    const host = new URL(baseUrl).host
    return FIRST_PARTY_NOUMENA_HOSTS.includes(host)
  } catch {
    return false
  }
}

/**
 * Check whether the configured first-party base URL override points at a
 * Noumena-owned host. Returns true when no explicit override is set, because
 * the default OAuth BASE_API_URL path is still considered first-party.
 */
export function isFirstPartyNoumenaBaseUrl(): boolean {
  const baseUrl = getFirstPartyBaseUrlOverride()
  if (!baseUrl) {
    return true
  }
  return isFirstPartyBaseUrlValue(baseUrl)
}
