import { isInternalBuild } from 'src/capabilities/static.js'
import {
  fetchAndStoreUserRoles,
  refreshOAuthToken,
} from '../../services/oauth/client.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getAuthRuntime } from '../../auth/runtime/AuthRuntime.js'
import { errorMessage } from '../../utils/errors.js'
import { logForDebugging } from '../../utils/debug.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import { resetUserCache } from '../../utils/user.js'
import {
  buildOAuthRefreshStatusReport,
  formatOAuthRefreshExpiry,
  getOAuthRefreshRequestedScopes,
} from './oauthRefreshSession.js'

type LocalText = { type: 'text'; value: string }

function text(value: string): LocalText {
  return { type: 'text', value }
}

function usage(): string {
  return [
    'Usage:',
    '  /oauth-refresh',
    '  /oauth-refresh run',
    '  /oauth-refresh status',
  ].join('\n')
}

async function runRefresh(context: Parameters<LocalCommandCall>[1]): Promise<string> {
  const authRuntime = getAuthRuntime()
  const session = await authRuntime.resolveSession({ allowRefresh: false })

  if (session.headersKind !== 'bearer' || !session.accessToken) {
    return 'Cannot refresh OAuth: no OAuth token is currently available.'
  }

  if (!session.refreshTokenPresent) {
    return [
      'Cannot refresh OAuth: current token has no refresh token.',
      `Source: ${session.rawAuthTokenSource ?? session.principalSource}`,
      'This usually means env/FD-provided service token auth, which is non-refreshable.',
    ].join('\n')
  }

  const refreshToken = authRuntime.getCurrentManagedRefreshToken()
  if (!refreshToken) {
    return 'Cannot refresh OAuth: refresh token is unavailable.'
  }

  const requestedScopes = getOAuthRefreshRequestedScopes(session)

  const before = {
    expiresAt: session.accessTokenExpiresAt,
    source: session.rawAuthTokenSource ?? session.principalSource,
  }

  const refreshed = await refreshOAuthToken(refreshToken, {
    scopes: requestedScopes,
  })
  const saveResult = authRuntime.persistOAuthTokensIfNeeded(refreshed)
  authRuntime.clearManagedTokenCache()

  if (!saveResult.success) {
    throw new Error(saveResult.warning ?? 'Failed to persist refreshed OAuth token')
  }

  let rolesRefreshNote = ''
  try {
    await fetchAndStoreUserRoles(refreshed.accessToken)
  } catch (error) {
    // Limited-scope tokens can fail role fetch; keep refresh successful.
    rolesRefreshNote = `\nRole refresh skipped: ${errorMessage(error)}`
    logForDebugging(`oauth-refresh roles update skipped: ${errorMessage(error)}`, {
      level: 'error',
    })
  }

  // Same post-auth cache refresh style used by other auth-changing flows.
  resetUserCache()
  refreshGrowthBookAfterAuthChange()
  void refreshPolicyLimits()
  void refreshRemoteManagedSettings()
  context.setAppState(prev => ({
    ...prev,
    authVersion: prev.authVersion + 1,
  }))

  const after = authRuntime.getCurrentSession()
  const warning = saveResult.warning ? `\nWarning: ${saveResult.warning}` : ''
  return [
    'OAuth refresh completed.',
    `- source: ${before.source}`,
    `- previous expiry: ${formatOAuthRefreshExpiry(before.expiresAt)}`,
    `- current expiry: ${formatOAuthRefreshExpiry(after.accessTokenExpiresAt)}`,
    `- refresh token rotated: ${
      after.refreshTokenPresent && refreshToken !== refreshed.refreshToken
        ? 'yes'
        : 'no/unknown'
    }`,
    warning + rolesRefreshNote,
  ]
    .filter(Boolean)
    .join('\n')
}

export const call: LocalCommandCall = async (args, context) => {
  if (!isInternalBuild()) {
    return text('`/oauth-refresh` is only available in ANT builds.')
  }

  const subcommand = args.trim().toLowerCase()
  if (!subcommand || subcommand === 'run') {
    try {
      return text(await runRefresh(context))
    } catch (error) {
      return text(`OAuth refresh failed: ${errorMessage(error)}`)
    }
  }

  if (subcommand === 'status') {
    return text(
      buildOAuthRefreshStatusReport(getAuthRuntime().getCurrentSession()),
    )
  }

  return text(`Unknown subcommand "${subcommand}".\n\n${usage()}`)
}
