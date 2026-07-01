import { getOrganizationUUID } from '../../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import type { LeaseProviderMode } from '../runtime/leases.js'
import {
  buildRemoteSessionLease,
  type IssuedRuntimeLease,
} from '../runtime/leases.js'
import { getAuthRuntime } from '../runtime/AuthRuntime.js'
import type { ResolvedAuthSession } from '../runtime/types.js'

export const MANAGED_REMOTE_AUTH_REQUIRED_MESSAGE =
  'NCode managed remote sessions require a full-scope managed OAuth login. Console/API-key authentication is not sufficient. Run `code auth login --managed` and verify with `code auth status`.'

export type ManagedRemoteCapability = {
  accessToken: string
  orgUUID: string
  session: ResolvedAuthSession
}

export type ManagedRemoteRuntimeAuth = {
  getAccessToken: () => string | undefined
  onAuth401: (staleAccessToken: string) => Promise<boolean>
  refreshAccessToken: () => Promise<string | undefined>
  orgUUID: string
  session: ResolvedAuthSession
}

export type ManagedRemoteRuntimeLease = {
  accessToken: string
  lease: IssuedRuntimeLease
  orgUUID: string
  session: ResolvedAuthSession
}

export type ResolveManagedRemoteCapabilityOptions = {
  accessTokenOverride?: null | string
}

export type ResolveManagedRemoteRuntimeAuthFromCallbacksOptions = {
  getAccessToken: () => string | undefined
  onAuth401: (staleAccessToken: string) => Promise<boolean>
}

function getRemoteRuntimeProviderMode(
  session: ResolvedAuthSession,
): Exclude<LeaseProviderMode, 'third_party_provider'> {
  return session.rawApiKeySource === 'ANTHROPIC_API_KEY' && session.apiKey
    ? 'byok'
    : 'noumena_managed'
}

function normalizeAccessTokenOverride(
  value: null | string | undefined,
): null | string {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function hasUsableManagedRemotePrincipal(
  session: ResolvedAuthSession,
): boolean {
  return (
    session.principalSource === 'managed_oauth' &&
    session.sessionState === 'usable' &&
    Boolean(session.accessToken) &&
    session.scopes.includes('user:profile') &&
    session.scopes.includes('user:inference')
  )
}

export function hasManagedRemoteCommandPrincipal(
  session: ResolvedAuthSession,
): boolean {
  return (
    session.principalSource === 'managed_oauth' &&
    session.scopes.includes('user:inference')
  )
}

export function hasCurrentManagedRemoteCommandPrincipal(): boolean {
  try {
    return hasManagedRemoteCommandPrincipal(getAuthRuntime().getCurrentSession())
  } catch {
    return false
  }
}

export function hasManagedRemoteBootstrapAuth(params: {
  accessTokenOverride?: null | string
  session: ResolvedAuthSession
}): boolean {
  const accessTokenOverride = normalizeAccessTokenOverride(
    params.accessTokenOverride,
  )
  return (
    Boolean(accessTokenOverride) ||
    params.session.principalSource === 'managed_oauth'
  )
}

export function isExpiredManagedRemoteBootstrapSession(
  session: ResolvedAuthSession,
): boolean {
  return (
    session.principalSource === 'managed_oauth' &&
    session.sessionState === 'expired' &&
    session.accessTokenExpiresAt !== null &&
    session.accessTokenExpiresAt <= Date.now()
  )
}

export function shouldSkipManagedRemoteBootstrapBackoff(
  session: ResolvedAuthSession,
): boolean {
  if (!isExpiredManagedRemoteBootstrapSession(session)) {
    return false
  }

  const cfg = getGlobalConfig()
  return (
    cfg.bridgeOauthDeadExpiresAt != null &&
    (cfg.bridgeOauthDeadFailCount ?? 0) >= 3 &&
    session.accessTokenExpiresAt === cfg.bridgeOauthDeadExpiresAt
  )
}

export function persistManagedRemoteBootstrapFailure(
  session: ResolvedAuthSession,
): boolean {
  if (!isExpiredManagedRemoteBootstrapSession(session)) {
    return false
  }

  const deadExpiresAt = session.accessTokenExpiresAt
  saveGlobalConfig(c => ({
    ...c,
    bridgeOauthDeadExpiresAt: deadExpiresAt,
    bridgeOauthDeadFailCount:
      c.bridgeOauthDeadExpiresAt === deadExpiresAt
        ? (c.bridgeOauthDeadFailCount ?? 0) + 1
        : 1,
  }))
  return true
}

export async function resolveManagedRemoteCapability(
  options: ResolveManagedRemoteCapabilityOptions = {},
): Promise<ManagedRemoteCapability> {
  const activeSession = await getAuthRuntime().resolveSession({
    allowRefresh: true,
  })
  const session =
    activeSession.principalSource === 'managed_oauth'
      ? activeSession
      : (getAuthRuntime().getCurrentManagedSession() ?? activeSession)
  const accessTokenOverride = normalizeAccessTokenOverride(
    options.accessTokenOverride,
  )

  if (accessTokenOverride) {
    const orgUUID =
      session.identity.organizationUuid?.trim() || (await getOrganizationUUID())
    if (!orgUUID) {
      throw new Error('Unable to get organization UUID')
    }

    return {
      accessToken: accessTokenOverride,
      orgUUID,
      session,
    }
  }

  if (!hasUsableManagedRemotePrincipal(session) || !session.accessToken) {
    throw new Error(MANAGED_REMOTE_AUTH_REQUIRED_MESSAGE)
  }

  const orgUUID =
    session.identity.organizationUuid?.trim() || (await getOrganizationUUID())
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  return {
    accessToken: session.accessToken,
    orgUUID,
    session,
  }
}

export async function resolveManagedRemoteBootstrapCapability(
  options: ResolveManagedRemoteCapabilityOptions = {},
): Promise<ManagedRemoteCapability> {
  const activeSession = getAuthRuntime().getCurrentSession()
  const initialSession =
    activeSession.principalSource === 'managed_oauth'
      ? activeSession
      : (getAuthRuntime().getCurrentManagedSession() ?? activeSession)
  const accessTokenOverride = normalizeAccessTokenOverride(
    options.accessTokenOverride,
  )

  if (
    !hasManagedRemoteBootstrapAuth({
      accessTokenOverride,
      session: initialSession,
    })
  ) {
    throw new Error(MANAGED_REMOTE_AUTH_REQUIRED_MESSAGE)
  }

  if (
    !accessTokenOverride &&
    shouldSkipManagedRemoteBootstrapBackoff(initialSession)
  ) {
    throw new Error(MANAGED_REMOTE_AUTH_REQUIRED_MESSAGE)
  }

  try {
    return await resolveManagedRemoteCapability({
      accessTokenOverride,
    })
  } catch (error) {
    if (!accessTokenOverride) {
      persistManagedRemoteBootstrapFailure(getAuthRuntime().getCurrentSession())
    }
    throw error
  }
}

export async function resolveManagedRemoteRuntimeAuth(
  options: ResolveManagedRemoteCapabilityOptions = {},
): Promise<ManagedRemoteRuntimeAuth> {
  const runtimeLease = await resolveManagedRemoteRuntimeLease(options)
  const accessTokenOverride = normalizeAccessTokenOverride(
    options.accessTokenOverride,
  )

  const runtimeAuth: ManagedRemoteRuntimeAuth = {
    getAccessToken: () =>
      accessTokenOverride ??
      getAuthRuntime().getCurrentManagedSession()?.accessToken ??
      getAuthRuntime().getCurrentSession().accessToken ??
      undefined,
    onAuth401: staleAccessToken =>
      getAuthRuntime().recoverManagedOAuth401(staleAccessToken),
    refreshAccessToken: async () =>
      accessTokenOverride ??
      (await refreshManagedRemoteRuntimeAccessToken(runtimeAuth)),
    orgUUID: runtimeLease.orgUUID,
    session: runtimeLease.session,
  }

  return runtimeAuth
}

export async function resolveManagedRemoteRuntimeAuthFromCallbacks(
  options: ResolveManagedRemoteRuntimeAuthFromCallbacksOptions,
): Promise<ManagedRemoteRuntimeAuth> {
  const accessToken = normalizeAccessTokenOverride(options.getAccessToken())
  if (!accessToken) {
    throw new Error(MANAGED_REMOTE_AUTH_REQUIRED_MESSAGE)
  }

  const session = getAuthRuntime().getCurrentSession()
  const orgUUID =
    session.identity.organizationUuid?.trim() ||
    (await getOauthProfileFromOauthToken(accessToken))?.organization?.uuid?.trim()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  const runtimeAuth: ManagedRemoteRuntimeAuth = {
    getAccessToken: options.getAccessToken,
    onAuth401: options.onAuth401,
    refreshAccessToken: async () =>
      refreshManagedRemoteRuntimeAccessToken(runtimeAuth),
    orgUUID,
    session,
  }

  return runtimeAuth
}

export async function refreshManagedRemoteRuntimeAccessToken(
  runtimeAuth: Pick<ManagedRemoteRuntimeAuth, 'getAccessToken' | 'onAuth401'>,
): Promise<string | undefined> {
  const staleAccessToken = runtimeAuth.getAccessToken()
  await runtimeAuth.onAuth401(staleAccessToken ?? '')
  return runtimeAuth.getAccessToken() ?? staleAccessToken
}

export async function resolveManagedRemoteRuntimeLease(
  options: ResolveManagedRemoteCapabilityOptions = {},
): Promise<ManagedRemoteRuntimeLease> {
  const activeProviderSession = getAuthRuntime().getCurrentSession()
  const capability = await resolveManagedRemoteBootstrapCapability(options)
  const leaseSession =
    activeProviderSession.providerPlan.mode === 'byok_static_env'
      ? activeProviderSession
      : capability.session

  return {
    accessToken: capability.accessToken,
    orgUUID: capability.orgUUID,
    session: leaseSession,
    lease: buildRemoteSessionLease({
      organizationUuid: capability.orgUUID,
      providerMode: getRemoteRuntimeProviderMode(leaseSession),
      session: leaseSession,
    }),
  }
}

export function buildManagedRemoteRuntimeLeaseEnvironmentVariables(params: {
  baseEnvironmentVariables?: Record<string, string>
  runtimeLease: ManagedRemoteRuntimeLease
}): Record<string, string> {
  const envVars = {
    ...(params.baseEnvironmentVariables ?? {}),
    NCODE_REMOTE_RUNTIME_LEASE_ID: params.runtimeLease.lease.leaseId,
    NCODE_REMOTE_RUNTIME_LEASE_KIND: params.runtimeLease.lease.leaseKind,
    NCODE_REMOTE_RUNTIME_LEASE_STATE: params.runtimeLease.lease.state,
    NCODE_REMOTE_RUNTIME_EXECUTION_TARGET:
      params.runtimeLease.lease.executionTarget,
    NCODE_REMOTE_RUNTIME_PROVIDER_MODE:
      params.runtimeLease.lease.providerMode,
    NCODE_REMOTE_RUNTIME_RENEWABLE: params.runtimeLease.lease.renewable
      ? '1'
      : '0',
    NCODE_REMOTE_RUNTIME_RENEWAL_OWNER:
      params.runtimeLease.lease.renewalOwner,
    NCODE_REMOTE_RUNTIME_TOKEN_TRANSPORT: String(
      params.runtimeLease.lease.metadata.tokenTransport ?? 'oauth_env',
    ),
  }

  if (params.runtimeLease.lease.organizationUuid) {
    envVars.NCODE_REMOTE_RUNTIME_ORGANIZATION_UUID =
      params.runtimeLease.lease.organizationUuid
  }

  const accessTokenEnvVarName =
    params.runtimeLease.lease.metadata.accessTokenEnvVarName
  if (typeof accessTokenEnvVarName === 'string') {
    envVars[accessTokenEnvVarName] = params.runtimeLease.accessToken
  }

  if (
    params.runtimeLease.lease.providerMode === 'byok' &&
    params.runtimeLease.session.rawApiKeySource === 'ANTHROPIC_API_KEY' &&
    params.runtimeLease.session.apiKey
  ) {
    envVars.ANTHROPIC_API_KEY = params.runtimeLease.session.apiKey
  }

  return envVars
}
