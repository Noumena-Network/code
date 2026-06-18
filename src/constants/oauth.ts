import { isEnvTruthy } from 'src/utils/envUtils.js'
import { isInternalBuild } from 'src/capabilities/static.js'

// Default to prod config; local override for internal/dev builds only.
type OauthConfigType = 'prod' | 'local'

function getOauthConfigType(): OauthConfigType {
  if (isInternalBuild() && isEnvTruthy(process.env.USE_LOCAL_OAUTH)) {
    return 'local'
  }
  return 'prod'
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '')
}

export function getNoumenaIssuerBaseUrl(): string | null {
  const baseUrl = process.env.NOUMENA_ISSUER_BASE_URL?.trim()
  if (!baseUrl) {
    return null
  }
  return normalizeBaseUrl(baseUrl)
}

export function getNoumenaOauthWebBaseUrl(): string | null {
  const baseUrl = process.env.NOUMENA_OAUTH_WEB_BASE_URL?.trim()
  if (baseUrl) {
    return deriveNoumenaOauthWebBaseUrl(baseUrl) ?? normalizeBaseUrl(baseUrl)
  }
  const issuerBaseUrl = getNoumenaIssuerBaseUrl()
  if (!issuerBaseUrl) {
    return null
  }
  return deriveNoumenaOauthWebBaseUrl(issuerBaseUrl)
}

function deriveNoumenaOauthWebBaseUrl(baseUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return null
  }

  const hostname = parsed.hostname.toLowerCase()
  const isNoumenaHost =
    hostname.endsWith('.noumena.com') || hostname.endsWith('.noumena.test')
  if (!isNoumenaHost) {
    return null
  }

  const labels = parsed.hostname.split('.')
  const firstLabel = labels[0]?.toLowerCase() ?? ''
  if (
    !(
      firstLabel.startsWith('issuer') ||
      firstLabel.startsWith('auth') ||
      firstLabel.startsWith('api') ||
      firstLabel.startsWith('platform-api') ||
      firstLabel.startsWith('console')
    )
  ) {
    return null
  }

  labels[0] = 'code'
  return `${parsed.protocol}//${labels.join('.')}`
}

export function getOauthAuthorizeUrl(loginWithClaudeAi?: boolean): string {
  const noumenaOauthWebBaseUrl = getNoumenaOauthWebBaseUrl()
  if (noumenaOauthWebBaseUrl) {
    return `${noumenaOauthWebBaseUrl}/oauth/authorize`
  }
  return loginWithClaudeAi
    ? getOauthConfig().CLAUDE_AI_AUTHORIZE_URL
    : getOauthConfig().CONSOLE_AUTHORIZE_URL
}

export function getOauthTokenUrl(): string {
  const noumenaIssuerBaseUrl = getNoumenaIssuerBaseUrl()
  if (noumenaIssuerBaseUrl) {
    return `${noumenaIssuerBaseUrl}/oauth/token`
  }
  return getOauthConfig().TOKEN_URL
}

/**
 * Default first-party inference host used by the legacy compatibility API
 * contract when no explicit NOUMENA_BASE_URL override is present.
 * is present.
 */
export function getDefaultFirstPartyInferenceBaseUrl(): string {
  return getOauthConfig().BASE_API_URL
}

/**
 * Legacy SDK baseURL override kept only for the ant staging-OAuth
 * lane. This isolates the remaining direct `BASE_API_URL` dependency to one
 * helper until the SDK path is fully replaced.
 */
export function getLegacyAnthropicSdkBaseUrl(): string | undefined {
  return undefined
}

export function getOauthManualRedirectUrl(): string {
  const noumenaOauthWebBaseUrl = getNoumenaOauthWebBaseUrl()
  if (noumenaOauthWebBaseUrl) {
    return `${noumenaOauthWebBaseUrl}/oauth/code/callback?app=noumena-code`
  }
  // Legacy web callback endpoint owned by the existing OAuth web flow.
  // Keep this isolated until a Noumena-owned replacement is available.
  return getOauthConfig().MANUAL_REDIRECT_URL
}

export function getOauthSuccessUrl(loginWithClaudeAi?: boolean): string {
  const noumenaOauthWebBaseUrl = getNoumenaOauthWebBaseUrl()
  if (noumenaOauthWebBaseUrl) {
    return `${noumenaOauthWebBaseUrl}/oauth/code/success?app=noumena-code`
  }
  // Legacy web success pages. Keep behavior stable until platform owns
  // explicit Noumena success routes.
  return loginWithClaudeAi
    ? getOauthConfig().CLAUDEAI_SUCCESS_URL
    : getOauthConfig().CONSOLE_SUCCESS_URL
}

export function getOauthRolesUrl(): string {
  // Legacy compatibility helper. The primary `code/` auth path now uses the
  // Noumena platform URL builder directly.
  return getOauthConfig().ROLES_URL
}

export function getOauthCreateApiKeyUrl(): string {
  // Legacy compatibility helper. The primary `code/` auth path now uses the
  // Noumena platform URL builder directly.
  return getOauthConfig().API_KEY_URL
}

export function getOauthClientId(): string {
  const clientIdOverride =
    process.env.NOUMENA_OAUTH_CLIENT_ID ||
    process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    return clientIdOverride
  }
  if (getNoumenaIssuerBaseUrl()) {
    return 'noumena-code'
  }
  return getOauthConfig().CLIENT_ID
}

export function fileSuffixForOauthConfig(): string {
  if (process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
    return '-custom-oauth'
  }
  switch (getOauthConfigType()) {
    case 'local':
      return '-local-oauth'
    case 'prod':
      // No suffix for production config
      return ''
  }
}

export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference' as const
export const CLAUDE_AI_PROFILE_SCOPE = 'user:profile' as const
const CONSOLE_SCOPE = 'org:create_api_key' as const
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const

// Console OAuth scopes - for API key creation via Console
export const CONSOLE_OAUTH_SCOPES = [
  CONSOLE_SCOPE,
  CLAUDE_AI_PROFILE_SCOPE,
] as const

// App OAuth scopes for subscriber accounts
export const CLAUDE_AI_OAUTH_SCOPES = [
  CLAUDE_AI_PROFILE_SCOPE,
  CLAUDE_AI_INFERENCE_SCOPE,
  'user:sessions:ncode',
  'user:mcp_servers',
  'user:file_upload',
] as const

// All OAuth scopes - union of all scopes used by the CLI
// When logging in, request all scopes in order to handle both Console -> web redirect
// Ensure that `OAuthConsentPage` in apps repo is kept in sync with this list.
export const ALL_OAUTH_SCOPES = Array.from(
  new Set([...CONSOLE_OAUTH_SCOPES, ...CLAUDE_AI_OAUTH_SCOPES]),
)

type OauthConfig = {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  CLAUDE_AI_AUTHORIZE_URL: string
  /**
   * The claude.ai web origin. Separate from CLAUDE_AI_AUTHORIZE_URL because
   * that now routes through claude.com/cai/* for attribution — deriving
   * .origin from it would give claude.com, breaking links to /code,
   * /settings/connectors, and other claude.ai web pages.
   */
  CLAUDE_AI_ORIGIN: string
  TOKEN_URL: string
  API_KEY_URL: string
  ROLES_URL: string
  CONSOLE_SUCCESS_URL: string
  CLAUDEAI_SUCCESS_URL: string
  MANUAL_REDIRECT_URL: string
  CLIENT_ID: string
  OAUTH_FILE_SUFFIX: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
}

// Production OAuth configuration.
//
// Public builds default to Noumena-owned hosts. Anthropic BYOK remains
// supported via the ANTHROPIC_API_KEY override; it does not require
// Anthropic-hosted OAuth endpoints as the default.
const PROD_OAUTH_CONFIG = {
  BASE_API_URL: 'https://api.noumena.com',
  CONSOLE_AUTHORIZE_URL: 'https://code.noumena.com/oauth/authorize',
  CLAUDE_AI_AUTHORIZE_URL: 'https://code.noumena.com/oauth/authorize',
  CLAUDE_AI_ORIGIN: 'https://api.noumena.com',
  TOKEN_URL: 'https://api.noumena.com/oauth/token',
  API_KEY_URL: 'https://api.noumena.com/api/oauth/ncode/create_api_key',
  ROLES_URL: 'https://api.noumena.com/api/oauth/ncode/roles',
  CONSOLE_SUCCESS_URL:
    'https://code.noumena.com/oauth/code/success?app=noumena-code',
  CLAUDEAI_SUCCESS_URL:
    'https://code.noumena.com/oauth/code/success?app=noumena-code',
  MANUAL_REDIRECT_URL: 'https://code.noumena.com/oauth/code/callback',
  CLIENT_ID: 'noumena-code',
  OAUTH_FILE_SUFFIX: '',
  MCP_PROXY_URL: 'https://api.noumena.com',
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
} as const

/**
 * Client ID Metadata Document URL for MCP OAuth (CIMD / SEP-991).
 * When an MCP auth server advertises client_id_metadata_document_supported: true,
 * The CLI uses this URL as its client_id instead of Dynamic Client Registration.
 * The URL must point to a JSON document hosted by the auth provider.
 * See: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00
 */
export const MCP_CLIENT_METADATA_URL =
  'https://claude.ai/oauth/claude-code-client-metadata'


// Three local dev servers: :8000 api-proxy (`api dev start -g ccr`),
// :4000 app frontend, :3000 Console frontend. Env vars let
// scripts/local-oauth override if your layout differs.
function getLocalOauthConfig(): OauthConfig {
  const api =
    process.env.CLAUDE_LOCAL_OAUTH_API_BASE?.replace(/\/$/, '') ??
    'http://localhost:8000'
  const apps =
    process.env.CLAUDE_LOCAL_OAUTH_APPS_BASE?.replace(/\/$/, '') ??
    'http://localhost:4000'
  const consoleBase =
    process.env.CLAUDE_LOCAL_OAUTH_CONSOLE_BASE?.replace(/\/$/, '') ??
    'http://localhost:3000'
  return {
    BASE_API_URL: api,
    CONSOLE_AUTHORIZE_URL: `${consoleBase}/oauth/authorize`,
    CLAUDE_AI_AUTHORIZE_URL: `${apps}/oauth/authorize`,
    CLAUDE_AI_ORIGIN: apps,
    TOKEN_URL: `${api}/oauth/token`,
    API_KEY_URL: `${api}/api/oauth/ncode/create_api_key`,
    ROLES_URL: `${api}/api/oauth/ncode/roles`,
    CONSOLE_SUCCESS_URL: `${api}/oauth/code/success?app=noumena-code`,
    CLAUDEAI_SUCCESS_URL: `${api}/oauth/code/success?app=noumena-code`,
    MANUAL_REDIRECT_URL: `${api}/oauth/code/callback`,
    CLIENT_ID: '22422756-60c9-4084-8eb7-27705fd5cf9a',
    OAUTH_FILE_SUFFIX: '-local-oauth',
    MCP_PROXY_URL: 'http://localhost:8205',
    MCP_PROXY_PATH: '/v1/toolbox/shttp/mcp/{server_id}',
  }
}

// Allowed base URLs for CLAUDE_CODE_CUSTOM_OAUTH_URL override.
// Only FedStart/PubSec deployments are permitted to prevent OAuth tokens
// from being sent to arbitrary endpoints.
const ALLOWED_OAUTH_BASE_URLS = [
  'https://claude.fedstart.com',
  'https://claude-staging.fedstart.com',
]

// Default to prod config, override with test/staging if enabled
export function getOauthConfig(): OauthConfig {
  let config: OauthConfig = (() => {
    switch (getOauthConfigType()) {
      case 'local':
        return getLocalOauthConfig()
      case 'prod':
        return PROD_OAUTH_CONFIG
    }
  })()

  // Allow overriding all OAuth URLs to point to an approved FedStart deployment.
  // Only allowlisted base URLs are accepted to prevent credential leakage.
  const oauthBaseUrl = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  if (oauthBaseUrl) {
    const base = oauthBaseUrl.replace(/\/$/, '')
    if (!ALLOWED_OAUTH_BASE_URLS.includes(base)) {
      throw new Error(
        'Custom OAuth URL override is not an approved endpoint (CLAUDE_CODE_CUSTOM_OAUTH_URL).',
      )
    }
    config = {
      ...config,
      BASE_API_URL: base,
      CONSOLE_AUTHORIZE_URL: `${base}/oauth/authorize`,
      CLAUDE_AI_AUTHORIZE_URL: `${base}/oauth/authorize`,
      CLAUDE_AI_ORIGIN: base,
      TOKEN_URL: `${base}/oauth/token`,
      API_KEY_URL: `${base}/api/oauth/ncode/create_api_key`,
      ROLES_URL: `${base}/api/oauth/ncode/roles`,
      CONSOLE_SUCCESS_URL: `${base}/oauth/code/success?app=noumena-code`,
      CLAUDEAI_SUCCESS_URL: `${base}/oauth/code/success?app=noumena-code`,
      MANUAL_REDIRECT_URL: `${base}/oauth/code/callback`,
      OAUTH_FILE_SUFFIX: '-custom-oauth',
    }
  }

  // Allow CLIENT_ID override via environment variable (e.g., for Xcode integration)
  const clientIdOverride = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    config = {
      ...config,
      CLIENT_ID: clientIdOverride,
    }
  }

  return config
}
