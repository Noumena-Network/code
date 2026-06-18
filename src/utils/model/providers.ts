import chalk from 'chalk'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'

// Noumena is the only supported model/API provider in NCode. Legacy
// third-party cloud providers (Bedrock/Vertex/Foundry) and Anthropic-first-party
// base URL overrides are no longer supported, so the runtime provider is always
// Noumena-first-party.
export type APIProvider = 'firstParty'

const FIRST_PARTY_NOUMENA_HOSTS = [
  'api.noumena.com',
  'code.noumena.com',
]

export const NOUMENA_API_PROVIDER: APIProvider = 'firstParty'

const LEGACY_PROVIDER_ENV_VARS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'BEDROCK_BASE_URL',
  'VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
]

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

export function getLegacyProviderEnvVars(): string[] {
  return LEGACY_PROVIDER_ENV_VARS.filter(name => Boolean(process.env[name]))
}

export function warnIfLegacyProviderEnvVarsPresent(): void {
  const present = getLegacyProviderEnvVars()
  if (present.length === 0) {
    return
  }

  process.stderr.write(
    chalk.yellow(
      `Warning: Legacy provider environment variables are no longer supported and will be ignored: ${present.join(', ')}\n` +
        'NCode now only supports the Noumena API. Use NOUMENA_API_KEY and NOUMENA_BASE_URL instead.\n',
    ),
  )
}
