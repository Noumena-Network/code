import { getAPIProvider } from '../../utils/model/providers.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getApiKeyFromApiKeyHelper,
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  removeApiKey,
  saveApiKey,
  saveOAuthTokensIfNeeded,
  clearOAuthTokenCache,
} from '../../utils/auth.js'
import {
  getDirectApiKeyProviderMode,
  getDirectApiKeyEnvVarName,
  getDirectApiKeyEnvValue,
  isDirectApiKeyEnvVarName,
  isOpenAIDirectApiKeySource,
} from '../../utils/authEnv.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import type { OAuthTokens } from '../../services/oauth/types.js'
import { AuthRuntimeError } from './errors.js'
import { buildFirstPartyHeadersFromSession } from './headers.js'
import { buildAuthStatusView } from './status.js'
import type {
  AuthRuntime,
  AuthStatusView,
  BuildFirstPartyHeadersOptions,
  PrincipalSource,
  ProviderAuthKind,
  ProviderPlan,
  ResolveSessionOptions,
  ResolvedAuthSession,
  SessionState,
  SourceDetails,
} from './types.js'

function normalizeCredential(value: null | string | undefined): null | string {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function hasManagedInferenceScope(scopes: string[] | undefined): boolean {
  return Boolean(scopes?.includes('user:inference'))
}

function isStoredManagedTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null || Number.isNaN(expiresAt)) {
    return true
  }

  const bufferTime = 5 * 60 * 1000
  return Date.now() + bufferTime >= expiresAt
}

function getStoredManagedOauthTokens(requireInferenceScope = true) {
  try {
    const oauthData = getSecureStorage().read()?.claudeAiOauth
    if (!oauthData?.accessToken) {
      return null
    }
    if (requireInferenceScope && !hasManagedInferenceScope(oauthData.scopes)) {
      return null
    }
    return oauthData
  } catch {
    return null
  }
}

function getManagedSubscriptionName(subscriptionType: string | null): string {
  switch (subscriptionType) {
    case 'enterprise':
      return 'Noumena Enterprise'
    case 'team':
      return 'Noumena Team'
    case 'max':
      return 'Noumena Max'
    case 'pro':
      return 'Noumena Pro'
    default:
      return 'Noumena Managed'
  }
}

function isThirdPartyProviderMode(): boolean {
  return getAPIProvider() !== 'firstParty'
}

function getCurrentFirstPartyOauthAccount() {
  return isThirdPartyProviderMode() ? undefined : getGlobalConfig().oauthAccount
}

function getEffectiveApiKeyResult(
  apiKeyResult: ReturnType<typeof getAnthropicApiKeyWithSource>,
): {
  key: null | string
  source: ReturnType<typeof getAnthropicApiKeyWithSource>['source']
} {
  const directEnvSource = getDirectApiKeyEnvVarName()
  const directEnvKey = normalizeCredential(getDirectApiKeyEnvValue())

  if (directEnvSource && directEnvKey) {
    return {
      key: directEnvKey,
      source: directEnvSource,
    }
  }

  return {
    key: normalizeCredential(apiKeyResult.key),
    source: apiKeyResult.source,
  }
}

function mapPrincipalSource(params: {
  apiKeySource: ReturnType<typeof getAnthropicApiKeyWithSource>['source']
  authTokenSource: ReturnType<typeof getAuthTokenSource>['source']
  hasStoredManagedPrincipal: boolean
  using3P: boolean
}): PrincipalSource {
  const { apiKeySource, authTokenSource, hasStoredManagedPrincipal, using3P } = params

  if (using3P) {
    return 'third_party_provider'
  }

  if (
    process.env.NCODE_REMOTE_RUNTIME_TOKEN_TRANSPORT ===
      'static_api_key_env' &&
    isDirectApiKeyEnvVarName(apiKeySource)
  ) {
    return 'direct_api_key_env'
  }

  if (
    process.env.NCODE_REMOTE_RUNTIME_PROVIDER_MODE === 'byok' &&
    apiKeySource === 'ANTHROPIC_API_KEY'
  ) {
    return 'direct_api_key_env'
  }
  if (
    process.env.NCODE_REMOTE_RUNTIME_PROVIDER_MODE === 'byok_openai' &&
    apiKeySource === 'OPENAI_API_KEY'
  ) {
    return 'direct_api_key_env'
  }

  if (authTokenSource === 'ANTHROPIC_AUTH_TOKEN') {
    return 'external_bearer_compat'
  }
  if (
    authTokenSource === 'NCODE_OAUTH_TOKEN' ||
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN'
  ) {
    return 'service_oauth_env'
  }
  if (
    authTokenSource === 'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR' ||
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' ||
    authTokenSource === 'CCR_OAUTH_TOKEN_FILE'
  ) {
    return 'service_oauth_fd'
  }
  if (isDirectApiKeyEnvVarName(apiKeySource)) {
    return 'direct_api_key_env'
  }
  if (hasStoredManagedPrincipal || authTokenSource === 'noumena.com') {
    return 'managed_oauth'
  }
  if (apiKeySource === '/login managed key') {
    return 'console_api_key'
  }
  if (apiKeySource === 'apiKeyHelper') {
    return 'api_key_helper'
  }

  return 'none'
}

function buildSourceDetails(
  principalSource: PrincipalSource,
  rawAuthTokenSource: string | null,
  rawApiKeySource: string | null,
): SourceDetails {
  const rawSources = [rawAuthTokenSource, rawApiKeySource].filter(
    (value): value is string => Boolean(value),
  )

  return {
    usedLegacyCompat:
      principalSource === 'external_bearer_compat' ||
      rawSources.some(source =>
        source.startsWith('CLAUDE_') ||
        source.startsWith('ANTHROPIC_') ||
        source.startsWith('CCR_'),
      ),
    usedEnvVar:
      principalSource === 'service_oauth_env' ||
      principalSource === 'direct_api_key_env' ||
      principalSource === 'external_bearer_compat',
    usedFileDescriptor:
      principalSource === 'service_oauth_fd' ||
      principalSource === 'service_api_key_fd',
    usedHelper: principalSource === 'api_key_helper',
  }
}

function buildRecovery(params: {
  principalSource: PrincipalSource
  sessionState: SessionState
}): Pick<ResolvedAuthSession, 'recoveryAction' | 'recoveryMessage'> {
  const { principalSource, sessionState } = params

  if (principalSource === 'managed_oauth' && sessionState === 'expired') {
    return {
      recoveryAction: 'run_auth_login_managed',
      recoveryMessage:
        'Managed OAuth expired. Run auth login --managed to re-authenticate.',
    }
  }

  if (
    principalSource === 'direct_api_key_env' ||
    principalSource === 'console_api_key'
  ) {
    return {
      recoveryAction: sessionState === 'usable' ? 'none' : 'check_api_key',
      recoveryMessage:
        sessionState === 'usable'
          ? null
          : 'API key authentication is unavailable. Check the configured API key and try again.',
    }
  }

  if (
    principalSource === 'service_oauth_env' ||
    principalSource === 'service_oauth_fd' ||
    principalSource === 'service_api_key_fd' ||
    principalSource === 'external_bearer_compat'
  ) {
    return {
      recoveryAction:
        sessionState === 'usable' ? 'none' : 'check_service_credential',
      recoveryMessage:
        sessionState === 'usable'
          ? null
          : 'Service credential is unavailable. Check the configured credential and try again.',
    }
  }

  return {
    recoveryAction:
      sessionState === 'usable' || principalSource === 'third_party_provider'
        ? 'none'
        : 'run_auth_login',
    recoveryMessage:
      sessionState === 'usable' || principalSource === 'third_party_provider'
        ? null
        : 'Not logged in. Run auth login to authenticate.',
  }
}

function buildProviderPlan(params: {
  using3P: boolean
  principalSource: PrincipalSource
  rawApiKeySource: string | null
}): ProviderPlan {
  const { using3P, principalSource, rawApiKeySource } = params

  if (using3P) {
    return {
      mode: 'third_party_provider',
      source: 'third_party_provider',
      staticKeyEnvVarName: null,
    }
  }

  if (principalSource === 'direct_api_key_env') {
    return {
      mode: getDirectApiKeyProviderMode() ?? 'noumena_managed',
      source: 'direct_api_key_env',
      staticKeyEnvVarName: rawApiKeySource,
    }
  }

  if (principalSource === 'console_api_key') {
    return {
      mode: 'noumena_managed',
      source: 'console_api_key',
      staticKeyEnvVarName: null,
    }
  }

  if (principalSource === 'api_key_helper') {
    return {
      mode: 'noumena_managed',
      source: 'api_key_helper',
      staticKeyEnvVarName: null,
    }
  }

  if (principalSource === 'none') {
    return {
      mode: 'none',
      source: 'none',
      staticKeyEnvVarName: null,
    }
  }

  return {
    mode: 'noumena_managed',
    source:
      principalSource === 'third_party_provider'
        ? 'third_party_provider'
        : principalSource === 'managed_oauth'
          ? 'managed_principal'
          : 'service_credential',
    staticKeyEnvVarName: null,
  }
}

function buildProviderAuthKind(providerPlan: ProviderPlan): ProviderAuthKind {
  switch (providerPlan.mode) {
    case 'noumena_managed':
      return 'noumena_first_party'
    case 'byok_static_env':
      return 'byok_static_env'
    case 'third_party_provider':
      return 'third_party_provider'
    case 'none':
      return 'none'
  }
}

function buildManagedSessionSnapshot(): null | ResolvedAuthSession {
  const storedManagedTokens = getStoredManagedOauthTokens(false)
  const storedManagedAccount = getGlobalConfig().oauthAccount

  if (!storedManagedTokens && !storedManagedAccount) {
    return null
  }

  const sessionState: SessionState = storedManagedTokens
    ? isStoredManagedTokenExpired(storedManagedTokens.expiresAt)
      ? 'expired'
      : 'usable'
    : 'expired'
  const recovery = buildRecovery({
    principalSource: 'managed_oauth',
    sessionState,
  })

  return {
    principalKind: 'noumena_account',
    principalSource: 'managed_oauth',
    sessionState,
    headersKind: 'bearer',
    providerAuthKind: 'noumena_first_party',
    providerPlan: {
      mode: 'noumena_managed',
      source: 'managed_principal',
      staticKeyEnvVarName: null,
    },

    isInteractive: !getIsNonInteractiveSession(),
    canRefresh: Boolean(storedManagedTokens?.refreshToken),
    canReauthenticateInteractively: !getIsNonInteractiveSession(),

    identity: {
      email: storedManagedAccount?.emailAddress ?? null,
      accountUuid: storedManagedAccount?.accountUuid ?? null,
      organizationUuid: storedManagedAccount?.organizationUuid ?? null,
      organizationName: storedManagedAccount?.organizationName ?? null,
    },
    subscription: {
      subscriptionName: getManagedSubscriptionName(
        storedManagedTokens?.subscriptionType ?? null,
      ),
      subscriptionType: storedManagedTokens?.subscriptionType ?? null,
      rateLimitTier: storedManagedTokens?.rateLimitTier ?? null,
    },
    scopes: storedManagedTokens?.scopes ?? [],

    hasUsableToken: sessionState === 'usable',
    hasUsableApiKey: false,

    accessToken: normalizeCredential(storedManagedTokens?.accessToken),
    accessTokenExpiresAt: storedManagedTokens?.expiresAt ?? null,
    refreshTokenPresent: Boolean(storedManagedTokens?.refreshToken),
    apiKey: null,

    rawAuthTokenSource: 'noumena.com',
    rawApiKeySource: null,

    recoveryAction: recovery.recoveryAction,
    recoveryMessage: recovery.recoveryMessage,

    sourceDetails: buildSourceDetails('managed_oauth', 'noumena.com', null),
  }
}

function resolveSessionSnapshot(): ResolvedAuthSession {
  const using3P = isThirdPartyProviderMode()
  const authToken = getAuthTokenSource()
  const apiKeyResult = getEffectiveApiKeyResult(getAnthropicApiKeyWithSource())
  const oauthTokens = getClaudeAIOAuthTokens()
  const oauthAccount = getCurrentFirstPartyOauthAccount()
  const storedManagedTokens = getStoredManagedOauthTokens()
  const storedManagedAccount = getGlobalConfig().oauthAccount
  const hasStoredManagedPrincipal = Boolean(
    storedManagedTokens || storedManagedAccount,
  )
  const principalSource = mapPrincipalSource({
    apiKeySource: apiKeyResult.source,
    authTokenSource: authToken.source,
    hasStoredManagedPrincipal,
    using3P,
  })
  const canonicalAuthTokenSource =
    authToken.source === 'CLAUDE_CODE_SESSION_ACCESS_TOKEN' ||
    authToken.source === 'CLAUDE_SESSION_INGRESS_TOKEN_FILE'
      ? 'none'
      : authToken.source

  const resolvedOauthTokens =
    principalSource === 'managed_oauth' ? storedManagedTokens : oauthTokens
  const resolvedOauthAccount =
    principalSource === 'managed_oauth' ? storedManagedAccount : oauthAccount
  const compatExternalBearer = normalizeCredential(
    process.env.ANTHROPIC_AUTH_TOKEN,
  )

  const accessToken =
    principalSource === 'external_bearer_compat'
      ? compatExternalBearer
      : normalizeCredential(resolvedOauthTokens?.accessToken)
  const apiKey = apiKeyResult.key
  const managedSessionState: SessionState = storedManagedTokens
    ? isStoredManagedTokenExpired(storedManagedTokens.expiresAt)
      ? 'expired'
      : 'usable'
    : 'expired'
  const hasUsableToken =
    principalSource === 'managed_oauth'
      ? managedSessionState === 'usable'
      : Boolean(accessToken)
  const hasUsableApiKey = Boolean(apiKey)
  const rawApiKeySource =
    apiKeyResult.source !== 'none' ? apiKeyResult.source : null
  const providerPlan = buildProviderPlan({
    using3P,
    principalSource,
    rawApiKeySource,
  })

  let principalKind: ResolvedAuthSession['principalKind'] = 'none'
  let sessionState: SessionState = 'unauthenticated'
  let headersKind: ResolvedAuthSession['headersKind'] = 'none'

  if (principalSource === 'third_party_provider') {
    principalKind = 'third_party_provider'
    sessionState = 'usable'
  } else if (principalSource === 'managed_oauth') {
    principalKind = 'noumena_account'
    sessionState = managedSessionState
    headersKind = 'bearer'
  } else if (principalSource === 'console_api_key') {
    principalKind = 'noumena_account'
    sessionState = hasUsableApiKey ? 'usable' : 'invalid'
    headersKind = 'api_key'
  } else if (principalSource === 'api_key_helper') {
    principalKind = 'api_key_user'
    sessionState = hasUsableApiKey ? 'usable' : 'invalid'
    headersKind = 'bearer'
  } else if (principalSource === 'direct_api_key_env') {
    principalKind = 'api_key_user'
    sessionState = hasUsableApiKey ? 'usable' : 'invalid'
    headersKind = isOpenAIDirectApiKeySource(rawApiKeySource)
      ? 'none'
      : 'api_key'
  } else if (principalSource !== 'none') {
    principalKind = 'service_principal'
    sessionState = hasUsableToken ? 'usable' : 'invalid'
    headersKind = 'bearer'
  }

  const recovery = buildRecovery({
    principalSource,
    sessionState,
  })

  return {
    principalKind,
    principalSource,
    sessionState,
    headersKind,
    providerAuthKind: buildProviderAuthKind(providerPlan),
    providerPlan,

    isInteractive: !getIsNonInteractiveSession(),
    canRefresh:
      principalSource === 'managed_oauth' &&
      Boolean(resolvedOauthTokens?.refreshToken),
    canReauthenticateInteractively:
      principalSource === 'managed_oauth' && !getIsNonInteractiveSession(),

    identity: {
      email: resolvedOauthAccount?.emailAddress ?? null,
      accountUuid: resolvedOauthAccount?.accountUuid ?? null,
      organizationUuid: resolvedOauthAccount?.organizationUuid ?? null,
      organizationName: resolvedOauthAccount?.organizationName ?? null,
    },
    subscription: {
      subscriptionName:
        principalSource === 'managed_oauth'
          ? getManagedSubscriptionName(
              storedManagedTokens?.subscriptionType ?? null,
            )
          : null,
      subscriptionType:
        principalSource === 'managed_oauth'
          ? storedManagedTokens?.subscriptionType ?? null
          : null,
      rateLimitTier:
        principalSource === 'managed_oauth'
          ? storedManagedTokens?.rateLimitTier ?? null
          : null,
    },
    scopes: resolvedOauthTokens?.scopes ?? [],

    hasUsableToken,
    hasUsableApiKey,

    accessToken,
    accessTokenExpiresAt: resolvedOauthTokens?.expiresAt ?? null,
    refreshTokenPresent: Boolean(resolvedOauthTokens?.refreshToken),
    apiKey,

    rawAuthTokenSource:
      principalSource === 'managed_oauth'
        ? 'noumena.com'
        : canonicalAuthTokenSource !== 'none'
          ? canonicalAuthTokenSource
          : null,
    rawApiKeySource,

    recoveryAction: recovery.recoveryAction,
    recoveryMessage: recovery.recoveryMessage,

    sourceDetails: buildSourceDetails(
      principalSource,
      principalSource === 'managed_oauth'
        ? 'noumena.com'
        : canonicalAuthTokenSource !== 'none'
          ? canonicalAuthTokenSource
          : null,
      rawApiKeySource,
    ),
  }
}

class DefaultAuthRuntime implements AuthRuntime {
  private cachedSession: ResolvedAuthSession | null = null

  private async maybeWarmApiKeyHelperSession(
    session: ResolvedAuthSession,
  ): Promise<ResolvedAuthSession> {
    if (
      session.principalSource !== 'api_key_helper' ||
      session.hasUsableApiKey
    ) {
      return session
    }

    await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
    return this.getCurrentSession()
  }

  getCurrentSession(): ResolvedAuthSession {
    const session = resolveSessionSnapshot()
    this.cachedSession = session
    return session
  }

  getCurrentManagedSession(): null | ResolvedAuthSession {
    return buildManagedSessionSnapshot()
  }

  getCurrentManagedRefreshToken(): null | string {
    return normalizeCredential(getStoredManagedOauthTokens(false)?.refreshToken)
  }

  recoverManagedOAuth401(failedAccessToken: string): Promise<boolean> {
    return handleOAuth401Error(failedAccessToken)
  }

  persistStoredApiKey(apiKey: string): Promise<void> {
    return saveApiKey(apiKey)
  }

  persistOAuthTokensIfNeeded(tokens: OAuthTokens): {
    success: boolean
    warning?: string
  } {
    return saveOAuthTokensIfNeeded(tokens)
  }

  clearManagedTokenCache(): void {
    clearOAuthTokenCache()
  }

  async removeStoredApiKey(): Promise<void> {
    await removeApiKey()
  }

  getCachedSession(): ResolvedAuthSession | null {
    return this.cachedSession
  }

  async resolveSession(
    options: ResolveSessionOptions = {},
  ): Promise<ResolvedAuthSession> {
    const initialSession = this.getCurrentSession()
    if (
      options.allowRefresh &&
      initialSession.principalSource === 'managed_oauth'
    ) {
      await checkAndRefreshOAuthTokenIfNeeded(0, options.forceRefresh ?? false)
    }

    return await this.maybeWarmApiKeyHelperSession(this.getCurrentSession())
  }

  async buildFirstPartyHeaders(
    options: BuildFirstPartyHeadersOptions = {},
  ): Promise<Record<string, string>> {
    const session = await this.resolveSession({
      allowRefresh: options.allowRefresh ?? true,
    })

    if (
      session.principalSource === 'managed_oauth' &&
      session.sessionState !== 'usable'
    ) {
      throw new AuthRuntimeError({
        code: 'managed_oauth_expired',
        message:
          'Managed OAuth authentication expired and could not be refreshed.',
        userMessage:
          'Managed OAuth authentication expired and could not be refreshed. Refusing to send a stale bearer token. Run `code auth login --managed` to re-authenticate.',
        recoveryAction: 'run_auth_login_managed',
      })
    }

    return buildFirstPartyHeadersFromSession({
      session,
      apiKey: options.apiKey,
      includeApiKeyHeader:
        options.includeApiKeyHeader ?? session.headersKind === 'api_key',
    })
  }

  async getStatusView(): Promise<AuthStatusView> {
    const session = await this.resolveSession()
    return buildAuthStatusView(session)
  }
}

const authRuntime = new DefaultAuthRuntime()

export function getAuthRuntime(): AuthRuntime {
  return authRuntime
}
