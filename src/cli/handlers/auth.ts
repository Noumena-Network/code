
import {
  cliError,
  cliOk,
} from '../exit.js'
import {
  clearAuthRelatedCaches,
  performLogout,
} from '../../commands/logout/logout.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getSSLErrorHint } from '../../services/api/errorUtils.js'
import { fetchAndStoreClaudeCodeFirstTokenDate } from '../../services/api/firstTokenDate.js'
import {
  createAndStoreApiKey,
  fetchAndStoreUserRoles,
  refreshOAuthToken,
  shouldUseClaudeAIAuth,
  storeOAuthAccountInfo,
} from '../../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js'
import { OAuthService } from '../../services/oauth/index.js'
import type { OAuthTokens } from '../../services/oauth/types.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { validateForceLoginOrgForCurrentSession } from '../../utils/forceLoginOrgSession.js'
import { logError } from '../../utils/log.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { buildAPIProviderProperties } from '../../utils/status.js'
import { getAuthRuntime } from '../../auth/runtime/AuthRuntime.js'
import { getLeaseManager } from '../../auth/runtime/LeaseManager.js'

/**
 * Shared post-token-acquisition logic. Saves tokens, fetches profile/roles,
 * and sets up the local auth state.
 */
export type OAuthInstallMode = 'auto' | 'managed' | 'console'
export type AuthLoginUiOptions = {
  openingMessage?: string
  urlMessagePrefix?: string
  successMessage?: null | string
}

const STUB_ACCOUNT_UUID = 'acct_stub'
const STUB_ORGANIZATION_UUID = '00000000-0000-4000-8000-000000000002'

function usesManagedInstallMode(
  tokens: OAuthTokens,
  mode: OAuthInstallMode,
): boolean {
  switch (mode) {
    case 'managed':
      return true
    case 'console':
      return false
    case 'auto':
    default:
      return shouldUseClaudeAIAuth(tokens.scopes)
  }
}

function isPresentIdentityValue(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function getManagedIdentityValidationError(
  tokens: OAuthTokens,
  profile: OAuthTokens['profile'],
  mode: OAuthInstallMode,
): string | null {
  if (!usesManagedInstallMode(tokens, mode)) {
    return null
  }

  const accountUuid = profile?.account?.uuid ?? tokens.tokenAccount?.uuid
  const emailAddress =
    profile?.account?.email ?? tokens.tokenAccount?.emailAddress
  const organizationUuid =
    profile?.organization?.uuid ?? tokens.tokenAccount?.organizationUuid

  if (
    !isPresentIdentityValue(accountUuid) ||
    !isPresentIdentityValue(emailAddress) ||
    !isPresentIdentityValue(organizationUuid)
  ) {
    return 'Managed OAuth login did not yield a usable Noumena account identity. The issuer returned incomplete account information, so remote sessions cannot be created.'
  }

  if (
    accountUuid === STUB_ACCOUNT_UUID ||
    organizationUuid === STUB_ORGANIZATION_UUID
  ) {
    return 'Managed OAuth login returned a stub Noumena identity. Remote sessions require a real account and organization binding.'
  }

  return null
}

export async function installOAuthTokens(
  tokens: OAuthTokens,
  { mode = 'auto' }: { mode?: OAuthInstallMode } = {},
): Promise<void> {
  // Clear old state before saving new credentials
  await performLogout({ clearOnboarding: false })

  // Reuse pre-fetched profile if available, otherwise fetch fresh
  const profile =
    tokens.profile ??
    (tokens.tokenAccount
      ? undefined
      : await getOauthProfileFromOauthToken(tokens.accessToken))
  const managedIdentityError = getManagedIdentityValidationError(
    tokens,
    profile,
    mode,
  )
  if (managedIdentityError) {
    throw new Error(managedIdentityError)
  }
  if (profile) {
    storeOAuthAccountInfo({
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email,
      organizationUuid: profile.organization.uuid,
      displayName: profile.account.display_name || undefined,
      hasExtraUsageEnabled:
        profile.organization.has_extra_usage_enabled ?? undefined,
      billingType: profile.organization.billing_type ?? undefined,
      subscriptionCreatedAt:
        profile.organization.subscription_created_at ?? undefined,
      accountCreatedAt: profile.account.created_at,
    })
  } else if (tokens.tokenAccount) {
    // Fallback to token exchange account data when profile endpoint fails
    storeOAuthAccountInfo({
      accountUuid: tokens.tokenAccount.uuid,
      emailAddress: tokens.tokenAccount.emailAddress,
      organizationUuid: tokens.tokenAccount.organizationUuid,
    })
  }

  const authRuntime = getAuthRuntime()
  const storageResult = authRuntime.persistOAuthTokensIfNeeded(tokens)
  authRuntime.clearManagedTokenCache()

  if (storageResult.warning) {
    logEvent('ncode_oauth_storage_warning', {
      warning:
        storageResult.warning as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  if (usesManagedInstallMode(tokens, mode)) {
    // Roles and first-token-date enrich UI state only; they are not required
    // for a usable managed OAuth session and must not block login.
    logForDebugging(
      'Skipping login-critical roles and first-token-date enrichment for managed OAuth.',
    )
  } else {
    await fetchAndStoreUserRoles(tokens.accessToken).catch(err =>
      logForDebugging(String(err), { level: 'error' }),
    )
    // API key creation is critical for Console users — let it throw.
    const apiKey = await createAndStoreApiKey(tokens.accessToken)
    if (!apiKey) {
      throw new Error(
        'Unable to create API key. The server accepted the request but did not return a key.',
      )
    }
  }

  await clearAuthRelatedCaches()
}

export async function performAuthLogin(
  {
    email,
    sso,
    console: useConsole,
    managed,
  }: {
    email?: string
    sso?: boolean
    console?: boolean
    managed?: boolean
  },
  uiOptions: AuthLoginUiOptions = {},
): Promise<void> {
  const {
    openingMessage = 'Opening browser to sign in…',
    urlMessagePrefix = `If the browser didn't open, visit: `,
    successMessage = 'Login successful.',
  } = uiOptions

  if (useConsole && managed) {
    throw new Error('--console and --managed cannot be used together.')
  }

  const settings = getInitialSettings()
  // forceLoginMethod is a hard constraint (enterprise setting) — matches ConsoleOAuthFlow behavior.
  // Without it, --console selects Console; --managed (or no flag) selects
  // managed OAuth.
  const loginWithClaudeAi = settings.forceLoginMethod
    ? settings.forceLoginMethod === 'claudeai'
    : !useConsole
  const installMode: OAuthInstallMode = loginWithClaudeAi
    ? 'managed'
    : 'console'
  const orgUUID = settings.forceLoginOrgUUID

  // Fast path: if a refresh token is provided via env var, skip the browser
  // OAuth flow and exchange it directly for tokens.
  const envRefreshToken = process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  if (envRefreshToken) {
    const envScopes = process.env.CLAUDE_CODE_OAUTH_SCOPES
    if (!envScopes) {
      throw new Error(
        'CLAUDE_CODE_OAUTH_SCOPES is required when using CLAUDE_CODE_OAUTH_REFRESH_TOKEN.\n' +
          'Set it to the space-separated scopes the refresh token was issued with\n' +
          '(e.g. "user:inference" or "user:profile user:inference user:sessions:claude_code user:mcp_servers").',
      )
    }

    const scopes = envScopes.split(/\s+/).filter(Boolean)

    logEvent('ncode_login_from_refresh_token', {})

    const tokens = await refreshOAuthToken(envRefreshToken, { scopes })
    await installOAuthTokens(tokens, { mode: installMode })

    const orgResult = await validateForceLoginOrgForCurrentSession()
    if (!orgResult.valid) {
      throw new Error(orgResult.message)
    }

    // Mark onboarding complete — interactive paths handle this via
    // the Onboarding component, but the env var path skips it.
    saveGlobalConfig(current => {
      if (current.hasCompletedOnboarding) return current
      return { ...current, hasCompletedOnboarding: true }
    })

    logEvent('ncode_oauth_success', {
      loginWithClaudeAi,
    })
    if (successMessage) {
      process.stdout.write(`${successMessage}\n`)
    }
    return
  }

  const resolvedLoginMethod = sso ? 'sso' : undefined

  const oauthService = new OAuthService()

  try {
    logEvent('ncode_oauth_flow_start', { loginWithClaudeAi })

    const result = await oauthService.startOAuthFlow(
      async url => {
        process.stdout.write(`${openingMessage}\n`)
        process.stdout.write(`${urlMessagePrefix}${url}\n`)
      },
      {
        loginWithClaudeAi,
        loginHint: email,
        loginMethod: resolvedLoginMethod,
        orgUUID,
      },
    )

    await installOAuthTokens(result, { mode: installMode })

    const orgResult = await validateForceLoginOrgForCurrentSession()
    if (!orgResult.valid) {
      throw new Error(orgResult.message)
    }

    logEvent('ncode_oauth_success', { loginWithClaudeAi })

    if (successMessage) {
      process.stdout.write(`${successMessage}\n`)
    }
  } finally {
    oauthService.cleanup()
  }
}

export async function authLogin({
  email,
  sso,
  console: useConsole,
  managed,
}: {
  email?: string
  sso?: boolean
  console?: boolean
  managed?: boolean
}): Promise<void> {
  if (useConsole && managed) {
    cliError(
      'Error: --console and --managed cannot be used together.',
    )
  }

  try {
    await performAuthLogin({
      email,
      sso,
      console: useConsole,
      managed,
    })
    cliOk()
  } catch (err) {
    logError(err)
    const sslHint = getSSLErrorHint(err)
    cliError(
      `Login failed: ${errorMessage(err)}\n${sslHint ? sslHint + '\n' : ''}`,
    )
  }
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const statusView = await getAuthRuntime().getStatusView()
  const continuityView = await getLeaseManager().getStatusView()

  if (opts.text) {
    const properties = [
      ...statusView.accountProperties,
      ...buildAPIProviderProperties(),
    ]
    let hasAuthProperty = false
    for (const prop of properties) {
      const value =
        typeof prop.value === 'string'
          ? prop.value
          : Array.isArray(prop.value)
            ? prop.value.join(', ')
            : null
      if (value === null || value === 'none') {
        continue
      }
      hasAuthProperty = true
      if (prop.label) {
        process.stdout.write(`${prop.label}: ${value}\n`)
      } else {
        process.stdout.write(`${value}\n`)
      }
    }
    process.stdout.write(
      `Continuity: ${formatContinuityStateLabel(continuityView.continuityState)}\n`,
    )
    process.stdout.write(
      `Lease renewal: ${formatLeaseRenewalStateLabel(continuityView.leaseRenewalState)}\n`,
    )
    if (continuityView.executionTarget) {
      process.stdout.write(
        `Execution: ${formatExecutionTargetLabel(continuityView.executionTarget)}\n`,
      )
    }
    if (statusView.recoveryMessage) {
      process.stdout.write(`${statusView.recoveryMessage}\n`)
    } else if (!statusView.loggedIn) {
      process.stdout.write('Not logged in. Run auth login to authenticate.\n')
    }
  } else {
    const output: Record<string, string | boolean | null> = {
      loggedIn: statusView.loggedIn,
      authMethod: statusView.authMethod,
      apiProvider: statusView.apiProvider,
    }
    if (statusView.authExpired) {
      output.authExpired = true
    }
    if (statusView.apiKeySource) {
      output.apiKeySource = statusView.apiKeySource
    }
    if (statusView.email || statusView.orgId || statusView.orgName) {
      output.email = statusView.email
      output.orgId = statusView.orgId
      output.orgName = statusView.orgName
    }
    if (statusView.subscriptionType) {
      output.subscriptionType = statusView.subscriptionType
    }
    output.continuityState = continuityView.continuityState
    output.leaseRenewalState = continuityView.leaseRenewalState
    if (continuityView.executionTarget) {
      output.executionTarget = continuityView.executionTarget
    }
    if (continuityView.leaseKind) {
      output.leaseKind = continuityView.leaseKind
    }
    if (continuityView.leaseState) {
      output.leaseState = continuityView.leaseState
    }

    process.stdout.write(jsonStringify(output, null, 2) + '\n')
  }
  if (statusView.loggedIn) {
    cliOk()
  } else {
    cliError()
  }
}

function formatContinuityStateLabel(
  state:
    | 'healthy'
    | 'renewing'
    | 'degraded'
    | 'reauth_required'
    | 'unavailable',
): string {
  switch (state) {
    case 'healthy':
      return 'Healthy'
    case 'renewing':
      return 'Renewing'
    case 'degraded':
      return 'Degraded'
    case 'reauth_required':
      return 'Re-authentication required'
    case 'unavailable':
      return 'Unavailable'
  }
}

function formatLeaseRenewalStateLabel(
  state:
    | 'healthy'
    | 'renewal_due'
    | 'grace_period'
    | 'degraded'
    | 'reauth_required'
    | 'not_applicable',
): string {
  switch (state) {
    case 'healthy':
      return 'Healthy'
    case 'renewal_due':
      return 'Renewal due'
    case 'grace_period':
      return 'Grace period'
    case 'degraded':
      return 'Degraded'
    case 'reauth_required':
      return 'Re-authentication required'
    case 'not_applicable':
      return 'Not applicable'
  }
}

function formatExecutionTargetLabel(
  executionTarget: 'local' | 'remote' | 'byoc',
): string {
  switch (executionTarget) {
    case 'local':
      return 'Local'
    case 'remote':
      return 'Remote'
    case 'byoc':
      return 'BYOC'
  }
}

export async function authLogout(): Promise<void> {
  try {
    await performLogout({ clearOnboarding: false })
  } catch {
    cliError('Failed to log out.')
  }
  cliOk('Successfully logged out.')
}
