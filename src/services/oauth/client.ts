// OAuth client for handling authentication flows with Noumena services
import axios from 'axios'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  ALL_OAUTH_SCOPES,
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_OAUTH_SCOPES,
  getOauthAuthorizeUrl,
  getOauthClientId,
  getOauthManualRedirectUrl,
  getOauthTokenUrl,
} from '../../constants/oauth.js'
import type { ResolvedAuthSession } from '../../auth/runtime/types.js'
import { getOAuthTokenFileDescriptorEnvVarName } from '../../utils/authFileDescriptor.js'
import type { AccountInfo } from '../../utils/config.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOauthProfileFromOauthToken } from './getOauthProfile.js'
import { getIdentityClient } from './identityClient.js'
import type {
  BillingType,
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
} from './types.js'

type OAuthClientSession =
  | Pick<
      ResolvedAuthSession,
      'providerPlan' | 'headersKind' | 'accessToken' | 'scopes' | 'subscription'
    >
  | null

function getCurrentOAuthClientSession(): OAuthClientSession {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getAuthRuntime } =
      require('../../auth/runtime/AuthRuntime.js') as typeof import('../../auth/runtime/AuthRuntime.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    return getAuthRuntime().getCurrentSession()
  } catch {
    return null
  }
}

async function resolveOAuthClientSession(params?: {
  allowRefresh?: boolean
}): Promise<OAuthClientSession> {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getAuthRuntime } =
      require('../../auth/runtime/AuthRuntime.js') as typeof import('../../auth/runtime/AuthRuntime.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    return await getAuthRuntime().resolveSession({
      allowRefresh: params?.allowRefresh ?? false,
    })
  } catch {
    return getCurrentOAuthClientSession()
  }
}

function hasOauthProfileAccess(session: OAuthClientSession): boolean {
  return (
    session?.providerPlan.mode === 'noumena_managed' &&
    session.headersKind === 'bearer' &&
    Boolean(session.accessToken) &&
    session.scopes.includes('user:profile')
  )
}

/**
 * Check if the user has Noumena authentication scope
 * @private Only call this if you're OAuth / auth related code!
 */
export function shouldUseClaudeAIAuth(scopes: string[] | undefined): boolean {
  return Boolean(scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE))
}

export function parseScopes(scopeString?: string): string[] {
  return scopeString?.split(' ').filter(Boolean) ?? []
}

export function buildAuthUrl({
  codeChallenge,
  state,
  port,
  isManual,
  manualRelayId,
  loginWithClaudeAi,
  inferenceOnly,
  orgUUID,
  loginHint,
  loginMethod,
}: {
  codeChallenge: string
  state: string
  port: number
  isManual: boolean
  manualRelayId?: string
  loginWithClaudeAi?: boolean
  inferenceOnly?: boolean
  orgUUID?: string
  loginHint?: string
  loginMethod?: string
}): string {
  const authUrlBase = getOauthAuthorizeUrl(loginWithClaudeAi)

  const authUrl = new URL(authUrlBase)
  authUrl.searchParams.append('code', 'true') // this tells the login page to show NCode Max upsell
  authUrl.searchParams.append('client_id', getOauthClientId())
  authUrl.searchParams.append('response_type', 'code')
  const manualRedirectUrl = new URL(getOauthManualRedirectUrl())
  if (manualRelayId) {
    manualRedirectUrl.searchParams.set('relay_id', manualRelayId)
  }
  authUrl.searchParams.append(
    'redirect_uri',
    isManual
      ? manualRedirectUrl.toString()
      : `http://localhost:${port}/callback`,
  )
  const scopesToUse = inferenceOnly
    ? [CLAUDE_AI_INFERENCE_SCOPE] // Long-lived inference-only tokens
    : ALL_OAUTH_SCOPES
  authUrl.searchParams.append('scope', scopesToUse.join(' '))
  authUrl.searchParams.append('code_challenge', codeChallenge)
  authUrl.searchParams.append('code_challenge_method', 'S256')
  authUrl.searchParams.append('state', state)

  // Add orgUUID as URL param if provided
  if (orgUUID) {
    authUrl.searchParams.append('orgUUID', orgUUID)
  }

  // Pre-populate email on the login form (standard OIDC parameter)
  if (loginHint) {
    authUrl.searchParams.append('login_hint', loginHint)
  }

  // Request a specific login method (e.g. 'sso', 'magic_link', 'google')
  if (loginMethod) {
    authUrl.searchParams.append('login_method', loginMethod)
  }

  return authUrl.toString()
}

function getOauthCallbackRelayEndpoint(path: string): string {
  return new URL(path, getOauthTokenUrl()).toString()
}

export async function registerOauthCallbackRelay(params: {
  relayId: string
  state: string
  timeoutMs?: number
}): Promise<void> {
  await axios.post(
    getOauthCallbackRelayEndpoint('/oauth/callback-relay/register'),
    {
      relay_id: params.relayId,
      state: params.state,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: params.timeoutMs ?? 1000,
    },
  )
}

export async function pollOauthCallbackRelay(
  relayId: string,
): Promise<string | null> {
  try {
    const response = await axios.post<{
      authorization_code?: string
      pending?: boolean
    }>(
      getOauthCallbackRelayEndpoint('/oauth/callback-relay/poll'),
      { relay_id: relayId },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
        validateStatus: status =>
          status === 200 || status === 202 || status === 204 || status === 404,
      },
    )
    if (response.status === 202 || response.status === 204 || response.status === 404) {
      return null
    }
    return response.data.authorization_code ?? null
  } catch (error) {
    logForDebugging(
      `OAuth callback relay poll failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}

export async function exchangeCodeForTokens(
  authorizationCode: string,
  state: string,
  codeVerifier: string,
  port: number,
  useManualRedirect: boolean = false,
  expiresIn?: number,
  manualRedirectUri?: string,
): Promise<OAuthTokenExchangeResponse> {
  const requestBody: Record<string, string | number> = {
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: useManualRedirect
      ? (manualRedirectUri ?? getOauthManualRedirectUrl())
      : `http://localhost:${port}/callback`,
    client_id: getOauthClientId(),
    code_verifier: codeVerifier,
    state,
  }

  if (expiresIn !== undefined) {
    requestBody.expires_in = expiresIn
  }

  const data = await getIdentityClient().exchangeCodeForTokens({
    requestBody,
    timeout: 15000,
  })
  logEvent('ncode_oauth_token_exchange_success', {})
  return data
}

export async function refreshOAuthToken(
  refreshToken: string,
  { scopes: requestedScopes }: { scopes?: string[] } = {},
): Promise<OAuthTokens> {
  const fallbackScopes =
    requestedScopes?.length ? requestedScopes : CLAUDE_AI_OAUTH_SCOPES
  const requestBody = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: getOauthClientId(),
    // Request specific scopes, defaulting to the full Noumena auth set. The
    // backend's refresh-token grant allows scope expansion beyond what the
    // initial authorize granted (see ALLOWED_SCOPE_EXPANSIONS), so this is
    // safe even for tokens issued before scopes were added to the app's
    // registered oauth_scope.
    scope: fallbackScopes.join(' '),
  }

  try {
    const data = await getIdentityClient().refreshOAuthToken({
      requestBody,
      timeout: 15000,
    })
    const {
      access_token: accessToken,
      refresh_token: newRefreshToken = refreshToken,
      expires_in: expiresIn,
    } = data

    const expiresAt = Date.now() + expiresIn * 1000
    const scopes = parseScopes(data.scope)
    const normalizedScopes = scopes.length > 0 ? scopes : fallbackScopes

    logEvent('ncode_oauth_token_refresh_success', {})

    // Skip the extra /api/oauth/profile round-trip when we already have both
    // the global-config profile fields AND the secure-storage subscription data.
    // Routine refreshes satisfy both, so we cut ~7M req/day fleet-wide.
    //
    // Checking secure storage (not just config) matters for the
    // CLAUDE_CODE_OAUTH_REFRESH_TOKEN re-login path: installOAuthTokens runs
    // performLogout() AFTER we return, wiping secure storage. If we returned
    // null for subscriptionType here, saveOAuthTokensIfNeeded would persist
    // null ?? (wiped) ?? null = null, and every future refresh would see the
    // config guard fields satisfied and skip again, permanently losing the
    // subscription type for paying users. By passing through existing values,
    // the re-login path writes cached ?? wiped ?? null = cached; and if secure
    // storage was already empty we fall through to the fetch.
    const config = getGlobalConfig()
    const existing = getCurrentOAuthClientSession()
    const haveProfileAlready =
      config.oauthAccount?.billingType !== undefined &&
      config.oauthAccount?.accountCreatedAt !== undefined &&
      config.oauthAccount?.subscriptionCreatedAt !== undefined &&
      existing?.subscription.subscriptionType != null &&
      existing?.subscription.rateLimitTier != null

    const profileInfo = haveProfileAlready
      ? null
      : await fetchProfileInfo(accessToken)

    // Update the stored properties if they have changed
    if (profileInfo && config.oauthAccount) {
      const updates: Partial<AccountInfo> = {}
      if (profileInfo.displayName !== undefined) {
        updates.displayName = profileInfo.displayName
      }
      if (typeof profileInfo.hasExtraUsageEnabled === 'boolean') {
        updates.hasExtraUsageEnabled = profileInfo.hasExtraUsageEnabled
      }
      if (profileInfo.billingType !== null) {
        updates.billingType = profileInfo.billingType
      }
      if (profileInfo.accountCreatedAt !== undefined) {
        updates.accountCreatedAt = profileInfo.accountCreatedAt
      }
      if (profileInfo.subscriptionCreatedAt !== undefined) {
        updates.subscriptionCreatedAt = profileInfo.subscriptionCreatedAt
      }
      if (Object.keys(updates).length > 0) {
        saveGlobalConfig(current => ({
          ...current,
          oauthAccount: current.oauthAccount
            ? { ...current.oauthAccount, ...updates }
            : current.oauthAccount,
        }))
      }
    }

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
      scopes: normalizedScopes,
      subscriptionType:
        profileInfo?.subscriptionType ??
        existing?.subscription.subscriptionType ??
        null,
      rateLimitTier:
        profileInfo?.rateLimitTier ??
        existing?.subscription.rateLimitTier ??
        null,
      profile: profileInfo?.rawProfile,
      tokenAccount: data.account
        ? {
            uuid: data.account.uuid,
            emailAddress: data.account.email_address,
            organizationUuid: data.organization?.uuid,
          }
        : undefined,
    }
  } catch (error) {
    const responseBody =
      axios.isAxiosError(error) && error.response?.data
        ? JSON.stringify(error.response.data)
        : undefined
    logEvent('ncode_oauth_token_refresh_failure', {
      error: (error as Error)
        .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(responseBody && {
        responseBody:
          responseBody as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
    throw error
  }
}

export async function fetchAndStoreUserRoles(
  accessToken: string,
): Promise<void> {
  const data = await getIdentityClient().fetchUserRoles({ accessToken })
  const config = getGlobalConfig()

  if (!config.oauthAccount) {
    throw new Error('OAuth account information not found in config')
  }

  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: current.oauthAccount
      ? {
          ...current.oauthAccount,
          organizationRole: data.organization_role,
          workspaceRole: data.workspace_role,
          organizationName: data.organization_name,
        }
      : current.oauthAccount,
  }))

  logEvent('ncode_oauth_roles_stored', {
    org_role:
      data.organization_role as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

export async function createAndStoreApiKey(
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await getIdentityClient().createApiKey({ accessToken })
    const apiKey = response.raw_key
    if (apiKey) {
      try {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { getAuthRuntime } =
          require('../../auth/runtime/AuthRuntime.js') as typeof import('../../auth/runtime/AuthRuntime.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        await getAuthRuntime().persistStoredApiKey(apiKey)
      } catch {
        // Keep oauth client usable in isolated tests/bundles where AuthRuntime
        // is not available yet.
      }
      logEvent('ncode_oauth_api_key', {
        status:
          'success' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        statusCode: response.status,
      })
      return apiKey
    }
    return null
  } catch (error) {
    logEvent('ncode_oauth_api_key', {
      status:
        'failure' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error: (error instanceof Error
        ? error.message
        : String(
            error,
          )) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    throw error
  }
}

export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null || Number.isNaN(expiresAt)) {
    return true
  }

  const bufferTime = 5 * 60 * 1000
  const now = Date.now()
  const expiresWithBuffer = now + bufferTime
  return expiresWithBuffer >= expiresAt
}

export async function fetchProfileInfo(accessToken: string, timeout = 10000): Promise<{
  subscriptionType: SubscriptionType | null
  displayName?: string
  rateLimitTier: RateLimitTier | null
  hasExtraUsageEnabled: boolean | null
  billingType: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
  rawProfile?: OAuthProfileResponse
}> {
  const profile = await getOauthProfileFromOauthToken(accessToken, timeout)
  const orgType = profile?.organization?.organization_type

  // Reuse the logic from fetchSubscriptionType
  let subscriptionType: SubscriptionType | null = null
  switch (orgType) {
    case 'claude_max':
      subscriptionType = 'max'
      break
    case 'claude_pro':
      subscriptionType = 'pro'
      break
    case 'claude_enterprise':
      subscriptionType = 'enterprise'
      break
    case 'claude_team':
      subscriptionType = 'team'
      break
    default:
      // Return null for unknown organization types
      subscriptionType = null
      break
  }

  const result: {
    subscriptionType: SubscriptionType | null
    displayName?: string
    rateLimitTier: RateLimitTier | null
    hasExtraUsageEnabled: boolean | null
    billingType: BillingType | null
    accountCreatedAt?: string
    subscriptionCreatedAt?: string
  } = {
    subscriptionType,
    rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
    hasExtraUsageEnabled:
      profile?.organization?.has_extra_usage_enabled ?? null,
    billingType: profile?.organization?.billing_type ?? null,
  }

  if (profile?.account?.display_name) {
    result.displayName = profile.account.display_name
  }

  if (profile?.account?.created_at) {
    result.accountCreatedAt = profile.account.created_at
  }

  if (profile?.organization?.subscription_created_at) {
    result.subscriptionCreatedAt = profile.organization.subscription_created_at
  }

  logEvent('ncode_oauth_profile_fetch_success', {})

  return { ...result, rawProfile: profile }
}

async function getOrganizationUUIDFromProfile(
  accessToken: string,
): Promise<string | null> {
  const profile = await getOauthProfileFromOauthToken(accessToken)
  const profileOrgUUID = profile?.organization?.uuid
  if (!profileOrgUUID) {
    return null
  }

  const accountUuid = profile.account?.uuid
  const emailAddress = profile.account?.email
  if (accountUuid && emailAddress) {
    storeOAuthAccountInfo({
      accountUuid,
      emailAddress,
      organizationUuid: profileOrgUUID,
      displayName: profile.account.display_name || undefined,
      hasExtraUsageEnabled:
        profile.organization?.has_extra_usage_enabled ?? undefined,
      billingType: profile.organization?.billing_type ?? undefined,
      accountCreatedAt: profile.account?.created_at,
      subscriptionCreatedAt:
        profile.organization?.subscription_created_at ?? undefined,
    })
  }

  return profileOrgUUID
}

/**
 * Gets the organization UUID from the OAuth access token
 * @returns The organization UUID or null if not authenticated
 */
export async function getOrganizationUUID(): Promise<string | null> {
  const globalConfig = getGlobalConfig()
  const cachedOrgUUID = globalConfig.oauthAccount?.organizationUuid
  const session = getCurrentOAuthClientSession()
  const accessToken =
    session?.headersKind === 'bearer' ? session.accessToken : null
  const hasInjectedOAuthToken = Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      getOAuthTokenFileDescriptorEnvVarName(),
  )

  // Env-injected OAuth tokens can override or outlive cached local account
  // state. Revalidate them against the profile endpoint when possible so
  // remote-session flows don't blindly reuse a stale organization UUID.
  if (accessToken && (hasInjectedOAuthToken || !cachedOrgUUID)) {
    const profileOrgUUID = await getOrganizationUUIDFromProfile(accessToken)
    if (profileOrgUUID) {
      return profileOrgUUID
    }
  }

  if (cachedOrgUUID) {
    return cachedOrgUUID
  }

  // Fall back to fetching from profile (requires user:profile scope)
  if (!accessToken || !hasOauthProfileAccess(session)) {
    return null
  }
  return getOrganizationUUIDFromProfile(accessToken)
}

/**
 * Populate the OAuth account info if it has not already been cached in config.
 * @returns Whether or not the oauth account info was populated.
 */
export async function populateOAuthAccountInfoIfNeeded(): Promise<boolean> {
  // Check env vars first (synchronous, no network call needed).
  // SDK callers like Cowork can provide account info directly, which also
  // eliminates the race condition where early telemetry events lack account info.
  // NB: If/when adding additional SDK-relevant functionality requiring _other_ OAuth account properties,
  // please reach out to #proj-cowork so the team can add additional env var fallbacks.
  const envAccountUuid = process.env.CLAUDE_CODE_ACCOUNT_UUID
  const envUserEmail = process.env.CLAUDE_CODE_USER_EMAIL
  const envOrganizationUuid = process.env.CLAUDE_CODE_ORGANIZATION_UUID
  const hasEnvVars = Boolean(
    envAccountUuid && envUserEmail && envOrganizationUuid,
  )
  if (envAccountUuid && envUserEmail && envOrganizationUuid) {
    if (!getGlobalConfig().oauthAccount) {
      storeOAuthAccountInfo({
        accountUuid: envAccountUuid,
        emailAddress: envUserEmail,
        organizationUuid: envOrganizationUuid,
      })
    }
  }

  // Wait for any in-flight token refresh to complete first, since
  // refreshOAuthToken already fetches and stores profile info
  const session = await resolveOAuthClientSession({ allowRefresh: true })

  const config = getGlobalConfig()
  if (
    (config.oauthAccount &&
      config.oauthAccount.billingType !== undefined &&
      config.oauthAccount.accountCreatedAt !== undefined &&
      config.oauthAccount.subscriptionCreatedAt !== undefined) ||
    !hasOauthProfileAccess(session)
  ) {
    return false
  }

  if (session.accessToken) {
    const profile = await getOauthProfileFromOauthToken(session.accessToken)
    if (profile) {
      if (hasEnvVars) {
        logForDebugging(
          'OAuth profile fetch succeeded, overriding env var account info',
          { level: 'info' },
        )
      }
      storeOAuthAccountInfo({
        accountUuid: profile.account.uuid,
        emailAddress: profile.account.email,
        organizationUuid: profile.organization.uuid,
        displayName: profile.account.display_name || undefined,
        hasExtraUsageEnabled:
          profile.organization.has_extra_usage_enabled ?? false,
        billingType: profile.organization.billing_type ?? undefined,
        accountCreatedAt: profile.account.created_at,
        subscriptionCreatedAt:
          profile.organization.subscription_created_at ?? undefined,
      })
      return true
    }
  }
  return false
}

export function storeOAuthAccountInfo({
  accountUuid,
  emailAddress,
  organizationUuid,
  displayName,
  hasExtraUsageEnabled,
  billingType,
  accountCreatedAt,
  subscriptionCreatedAt,
}: {
  accountUuid: string
  emailAddress: string
  organizationUuid: string | undefined
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}): void {
  const accountInfo: AccountInfo = {
    accountUuid,
    emailAddress,
    organizationUuid,
    hasExtraUsageEnabled,
    billingType,
    accountCreatedAt,
    subscriptionCreatedAt,
  }
  if (displayName) {
    accountInfo.displayName = displayName
  }
  saveGlobalConfig(current => {
    // For oauthAccount we need to compare content since it's an object
    if (
      current.oauthAccount?.accountUuid === accountInfo.accountUuid &&
      current.oauthAccount?.emailAddress === accountInfo.emailAddress &&
      current.oauthAccount?.organizationUuid === accountInfo.organizationUuid &&
      current.oauthAccount?.displayName === accountInfo.displayName &&
      current.oauthAccount?.hasExtraUsageEnabled ===
        accountInfo.hasExtraUsageEnabled &&
      current.oauthAccount?.billingType === accountInfo.billingType &&
      current.oauthAccount?.accountCreatedAt === accountInfo.accountCreatedAt &&
      current.oauthAccount?.subscriptionCreatedAt ===
        accountInfo.subscriptionCreatedAt
    ) {
      return current
    }
    return { ...current, oauthAccount: accountInfo }
  })
}
