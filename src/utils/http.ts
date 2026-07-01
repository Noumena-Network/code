/**
 * HTTP utility constants and helpers
 */

import axios from 'axios'
import { getAuthRuntime } from '../auth/runtime/AuthRuntime.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import { getGlobalConfig } from './config.js'
import { getNcodeUserAgent } from './userAgent.js'
import { getWorkload } from './workloadContext.js'

export function getUserAgent(): string {
  const agentSdkVersion = process.env.NCODE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.NCODE_AGENT_SDK_VERSION}`
    : ''
  // SDK consumers can identify their app/library via NCODE_AGENT_SDK_CLIENT_APP
  // e.g., "my-app/1.0.0" or "my-library/2.1"
  const clientApp = process.env.NCODE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.NCODE_AGENT_SDK_CLIENT_APP}`
    : ''
  // Turn-/process-scoped workload tag for cron-initiated requests. 1P-only
  // observability — proxies strip HTTP headers; QoS routing uses cc_workload
  // in the billing-header attribution block instead (see constants/system.ts).
  // getAnthropicClient (client.ts:98) calls this per-request inside withRetry,
  // so the read picks up the same setWorkload() value as getAttributionHeader.
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ''
  return `ncode/${MACRO.VERSION} (${process.env.USER_TYPE}, ${process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workloadSuffix})`
}

export function getMCPUserAgent(): string {
  const parts: string[] = []
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    parts.push(process.env.CLAUDE_CODE_ENTRYPOINT)
  }
  if (process.env.NCODE_AGENT_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.NCODE_AGENT_SDK_VERSION}`)
  }
  if (process.env.NCODE_AGENT_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.NCODE_AGENT_SDK_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `ncode/${MACRO.VERSION}${suffix}`
}

// User-Agent for WebFetch requests to arbitrary sites.
export function getWebFetchUserAgent(): string {
  return `NCode-User (${getNcodeUserAgent()}; +https://noumena.com/)`
}

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

export function getOrganizationUuidHeader(): Record<string, string> {
  const organizationUuid = (
    process.env.CLAUDE_CODE_ORGANIZATION_UUID ??
    getGlobalConfig().oauthAccount?.organizationUuid
  )?.trim()
  if (!organizationUuid) {
    return {}
  }
  return {
    'x-organization-uuid': organizationUuid,
  }
}

/**
 * Get authentication headers for API requests
 * Returns either OAuth headers for Max/Pro users or API key headers for regular users
 */
export function getAuthHeaders(): AuthHeaders {
  const session = getAuthRuntime().getCurrentSession()

  if (session.principalSource === 'managed_oauth') {
    if (session.sessionState !== 'usable' || !session.accessToken) {
      return {
        headers: {},
        error: 'No usable OAuth token available',
      }
    }
    return {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    }
  }

  if (
    (session.principalSource === 'service_oauth_env' ||
      session.principalSource === 'service_oauth_fd' ||
      session.principalSource === 'external_bearer_compat') &&
    session.accessToken
  ) {
    return {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    }
  }

  if (
    (session.principalSource === 'direct_api_key_env' ||
      session.principalSource === 'console_api_key' ||
      session.principalSource === 'api_key_helper') &&
    session.rawApiKeySource !== 'OPENAI_API_KEY' &&
    session.apiKey
  ) {
    return {
      headers: {
        'x-api-key': session.apiKey,
      },
    }
  }

  return {
    headers: {},
    error:
      session.principalSource === 'managed_oauth' ||
      session.headersKind === 'bearer'
        ? 'No usable OAuth token available'
        : 'No API key available',
  }
}

/**
 * Wrapper that handles OAuth 401 errors by force-refreshing the token and
 * retrying once. Addresses clock drift scenarios where the local expiration
 * check disagrees with the server.
 *
 * The request closure is called again on retry, so it should re-read auth
 * (e.g., via getAuthHeaders()) to pick up the refreshed token.
 *
 * Note: bridgeApi.ts has its own DI-injected version — handleOAuth401Error
 * transitively pulls in config.ts (~1300 modules), which breaks the SDK bundle.
 *
 * @param opts.also403Revoked - Also retry on 403 with "OAuth token has been
 *   revoked" body (some endpoints signal revocation this way instead of 401).
 */
export async function withOAuth401Retry<T>(
  request: () => Promise<T>,
  opts?: { also403Revoked?: boolean },
): Promise<T> {
  const initialSession = getAuthRuntime().getCurrentSession()
  if (initialSession.principalSource === 'managed_oauth') {
    await getAuthRuntime().resolveSession({ allowRefresh: true })
  }

  try {
    return await request()
  } catch (err) {
    if (!axios.isAxiosError(err)) throw err
    const status = err.response?.status
    const isAuthError =
      status === 401 ||
      (opts?.also403Revoked &&
        status === 403 &&
        typeof err.response?.data === 'string' &&
        err.response.data.includes('OAuth token has been revoked'))
    if (!isAuthError) throw err
    const failedAccessToken = getAuthRuntime().getCurrentSession().accessToken
    if (!failedAccessToken) throw err
    const recovered =
      await getAuthRuntime().recoverManagedOAuth401(failedAccessToken)
    if (!recovered) throw err
    return await request()
  }
}
