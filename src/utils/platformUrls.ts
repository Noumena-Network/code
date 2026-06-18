import { getOauthConfig } from '../constants/oauth.js'
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

export function getNoumenaPlatformBaseUrl(): string {
  const override = process.env.NOUMENA_PLATFORM_BASE_URL?.trim()
  if (override) {
    return normalizeBaseUrl(override)
  }
  return normalizeBaseUrl(getOauthConfig().BASE_API_URL)
}

/**
 * Session/file/bridge flows historically piggybacked on ANTHROPIC_BASE_URL in
 * first-party environments. During migration, preserve that compatibility only
 * when the legacy value still points at a trusted first-party Anthropic host.
 *
 * This intentionally ignores ANTHROPIC_BASE_URL when it points at a custom
 * gateway (for example a local inference override), because session/control
 * plane traffic must not be redirected there.
 */
export function getSessionCompatiblePlatformBaseUrl(): string {
  const noumenaOverride = process.env.NOUMENA_PLATFORM_BASE_URL?.trim()
  if (noumenaOverride) {
    return normalizeBaseUrl(noumenaOverride)
  }

  return normalizeBaseUrl(getOauthConfig().BASE_API_URL)
}

export function getNoumenaPlatformWebSocketBaseUrl(): string {
  const baseUrl = getNoumenaPlatformBaseUrl()
  if (baseUrl.startsWith('https://')) {
    return `wss://${baseUrl.slice('https://'.length)}`
  }
  if (baseUrl.startsWith('http://')) {
    return `ws://${baseUrl.slice('http://'.length)}`
  }
  return baseUrl
}

export function buildNoumenaPlatformUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path
  return `${getNoumenaPlatformBaseUrl()}/${normalizedPath}`
}

export function buildNoumenaPlatformWebSocketUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path
  return `${getNoumenaPlatformWebSocketBaseUrl()}/${normalizedPath}`
}
