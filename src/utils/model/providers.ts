import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import {
  getDirectApiKeyEnvVarName,
  isOpenAIDirectApiKeyEnvVar,
} from '../authEnv.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
export const OPENAI_COMPAT_DEFAULT_BASE_URL = 'https://api.openai.com'
export const OPENAI_COMPAT_DEFAULT_MODEL = 'gpt-5.1-codex'

const FIRST_PARTY_NOUMENA_HOSTS = [
  'api.noumena.com',
  'code.noumena.com',
]
const FIRST_PARTY_ANTHROPIC_HOSTS = ['api.anthropic.com']

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

export function getNoumenaBaseUrl(): string | undefined {
  return normalizeEnvValue(process.env.NOUMENA_BASE_URL)
}

export function getAnthropicBaseUrl(): string | undefined {
  return normalizeEnvValue(process.env.ANTHROPIC_BASE_URL)
}

export function getOpenAIBaseUrl(): string | undefined {
  return normalizeEnvValue(process.env.OPENAI_BASE_URL)
}

export function isOpenAICompatByokActive(): boolean {
  return isOpenAIDirectApiKeyEnvVar(getDirectApiKeyEnvVarName())
}

export function getOpenAICompatBaseUrl(): string | undefined {
  if (!isOpenAICompatByokActive()) {
    return undefined
  }
  return getOpenAIBaseUrl() ?? OPENAI_COMPAT_DEFAULT_BASE_URL
}

export function getOpenAICompatDefaultModel(): string {
  return normalizeEnvValue(process.env.OPENAI_MODEL) ?? OPENAI_COMPAT_DEFAULT_MODEL
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
