import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { _setGlobalConfigCacheForTesting, enableConfigs, saveGlobalConfig } from '../../utils/config.js'
import { clearOAuthTokenCache, saveOAuthTokensIfNeeded } from '../../utils/auth.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getAuthRuntime } from './AuthRuntime.js'
import {
  buildBridgeWorkerLease,
  buildLocalFirstPartyLease,
  buildRemoteSessionLease,
  buildSessionIngressLease,
  needsLeaseRenewal,
} from './leases.js'
import type { ResolvedAuthSession } from './types.js'

const envKeys = [
  'NODE_ENV',
  'CI',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NOUMENA_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'NCODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_ENTRYPOINT',
  'USER_TYPE',
  'NOUMENA_PLATFORM_BASE_URL',
  'NOUMENA_ISSUER_BASE_URL',
  'NOUMENA_OAUTH_WEB_BASE_URL',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

let tempConfigDir = ''

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function restoreEnv(): void {
  for (const key of envKeys) {
    restoreEnvVar(key, originalEnv[key])
  }
}

function setStableTestRuntime(): void {
  process.env.NODE_ENV = 'development'
  delete process.env.CI
  process.env.NCODE_CONFIG_DIR = tempConfigDir
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  process.env.NOUMENA_PLATFORM_BASE_URL = 'https://api.noumena.test'
  process.env.NOUMENA_ISSUER_BASE_URL = 'https://auth.noumena.test'
  process.env.NOUMENA_OAUTH_WEB_BASE_URL = 'https://console.noumena.test'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.USER_TYPE = 'test'
  delete process.env.NOUMENA_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-auth-lease-'))
  restoreEnv()
  setStableTestRuntime()
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
})

afterEach(async () => {
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  restoreEnv()
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
  }
  tempConfigDir = ''
})

function buildSession(
  overrides: Partial<ResolvedAuthSession> = {},
): ResolvedAuthSession {
  return {
    principalKind: 'noumena_account',
    principalSource: 'managed_oauth',
    sessionState: 'usable',
    headersKind: 'bearer',
    providerAuthKind: 'noumena_first_party',
    providerPlan: {
      mode: 'noumena_managed',
      source: 'managed_principal',
      staticKeyEnvVarName: null,
    },
    isInteractive: true,
    canRefresh: true,
    canReauthenticateInteractively: true,
    identity: {
      email: 'dev@noumena.com',
      accountUuid: 'acct-1',
      organizationUuid: 'org-1',
      organizationName: 'Acme',
    },
    subscription: {
      subscriptionName: 'Noumena Pro',
      subscriptionType: 'pro',
      rateLimitTier: 'tier-1',
    },
    scopes: ['user:inference', 'user:profile'],
    hasUsableToken: true,
    hasUsableApiKey: false,
    accessToken: 'managed-token',
    accessTokenExpiresAt: 1_700_000_900_000,
    refreshTokenPresent: true,
    apiKey: null,
    rawAuthTokenSource: 'noumena.com',
    rawApiKeySource: null,
    recoveryAction: 'none',
    recoveryMessage: null,
    sourceDetails: {
      usedLegacyCompat: false,
      usedEnvVar: false,
      usedFileDescriptor: false,
      usedHelper: false,
    },
    ...overrides,
  }
}

describe('runtime lease adapters', () => {
  it('builds a renewable local first-party lease from a managed session', () => {
    const session = buildSession()
    const lease = buildLocalFirstPartyLease(session, { nowMs: 1_700_000_000_000 })

    expect(lease).toMatchObject({
      leaseKind: 'local_first_party',
      state: 'usable',
      renewable: true,
      renewalOwner: 'local_runtime',
      executionTarget: 'local',
      providerMode: 'noumena_managed',
      degradationMode: 'none',
      organizationUuid: 'org-1',
    })
    expect(lease?.capabilities).toEqual(
      expect.arrayContaining(['first_party_api', 'inference']),
    )
    expect(lease?.expiresAt).toBe(1_700_000_900_000)
    expect(lease?.renewAfter).toBe(1_700_000_600_000)
    expect(lease?.graceUntil).toBe(1_700_001_200_000)
  })

  it('returns no local first-party lease for third-party provider sessions', () => {
    const session = buildSession({
      principalKind: 'third_party_provider',
      principalSource: 'third_party_provider',
      providerAuthKind: 'third_party_provider',
      providerPlan: {
        mode: 'third_party_provider',
        source: 'third_party_provider',
        staticKeyEnvVarName: null,
      },
    })

    expect(buildLocalFirstPartyLease(session)).toBeNull()
  })

  it('builds a bridge worker lease from current bridge credentials', () => {
    const lease = buildBridgeWorkerLease({
      credentials: {
        worker_jwt: 'worker-jwt',
        api_base_url: 'https://bridge.noumena.test',
        expires_in: 300,
        worker_epoch: 42,
      },
      nowMs: 1_700_000_000_000,
      organizationUuid: 'org-1',
      sessionId: 'cse_123',
    })

    expect(lease).toMatchObject({
      leaseKind: 'bridge_worker',
      leaseId: 'bridge_worker:cse_123:42',
      sessionId: 'cse_123',
      state: 'usable',
      renewable: true,
      renewalOwner: 'bridge_control_plane',
      executionTarget: 'remote',
      providerMode: 'noumena_managed',
      degradationMode: 'resume_required',
    })
    expect(lease.expiresAt).toBe(1_700_000_300_000)
    expect(lease.renewAfter).toBe(1_700_000_240_000)
    expect(lease.graceUntil).toBe(1_700_000_330_000)
    expect(lease.metadata).toMatchObject({
      apiBaseUrl: 'https://bridge.noumena.test',
      workerEpoch: 42,
      tokenTransport: 'jwt',
      ttlSeconds: 300,
    })
    expect(needsLeaseRenewal(lease, 1_700_000_239_999)).toBe(false)
    expect(needsLeaseRenewal(lease, 1_700_000_240_000)).toBe(true)
  })

  it('builds an explicit remote runtime lease that preserves the oauth env transport', () => {
    const lease = buildRemoteSessionLease({
      session: buildSession(),
      organizationUuid: 'org-1',
      sessionId: 'pending-session',
      nowMs: 1_700_000_000_000,
    })

    expect(lease).toMatchObject({
      leaseKind: 'remote_session',
      leaseId: 'remote_session:pending-session:org-1',
      sessionId: 'pending-session',
      state: 'usable',
      renewable: false,
      renewalOwner: 'none',
      executionTarget: 'remote',
      providerMode: 'noumena_managed',
      degradationMode: 'resume_required',
    })
    expect(lease.capabilities).toEqual(['remote_session', 'inference'])
    expect(lease.expiresAt).toBe(1_700_000_900_000)
    expect(lease.metadata).toMatchObject({
      principalKind: 'noumena_account',
      principalSource: 'managed_oauth',
      tokenTransport: 'oauth_env',
      accessTokenEnvVarName: 'NCODE_OAUTH_TOKEN',
    })
  })

  it('builds a session-ingress lease and preserves its transport kind', () => {
    const bearerLease = buildSessionIngressLease({
      token: 'jwt-token',
      sessionId: 'cse_123',
      organizationUuid: 'org-1',
    })
    const cookieLease = buildSessionIngressLease({
      token: 'sk-ant-sid-cookie-token',
      sessionId: 'cse_123',
      organizationUuid: 'org-1',
    })

    expect(bearerLease).toMatchObject({
      leaseKind: 'session_ingress',
      renewable: true,
      renewalOwner: 'session_runtime',
      executionTarget: 'remote',
      degradationMode: 'resume_required',
    })
    expect(bearerLease.metadata.tokenTransport).toBe('bearer')
    expect(cookieLease.metadata.tokenTransport).toBe('cookie')
    expect(needsLeaseRenewal(bearerLease)).toBe(false)
  })

  it('builds a local BYOK lease for static ANTHROPIC_API_KEY sessions', () => {
    const lease = buildLocalFirstPartyLease(
      buildSession({
        principalKind: 'api_key_user',
        principalSource: 'direct_api_key_env',
        headersKind: 'api_key',
        providerAuthKind: 'byok_static_env',
        providerPlan: {
          mode: 'byok_static_env',
          source: 'direct_api_key_env',
          staticKeyEnvVarName: 'ANTHROPIC_API_KEY',
        },
        canRefresh: false,
        canReauthenticateInteractively: false,
        hasUsableToken: false,
        hasUsableApiKey: true,
        accessToken: null,
        accessTokenExpiresAt: null,
        refreshTokenPresent: false,
        apiKey: 'anthropic-direct-key',
        rawAuthTokenSource: null,
        rawApiKeySource: 'ANTHROPIC_API_KEY',
      }),
      { nowMs: 1_700_000_000_000 },
    )

    expect(lease).toMatchObject({
      leaseKind: 'local_first_party',
      renewable: false,
      renewalOwner: 'none',
      executionTarget: 'local',
      providerMode: 'byok',
    })
    expect(lease?.capabilities).toEqual(['inference'])
  })

  it('can derive a local first-party continuity lease from the live auth runtime snapshot', async () => {
    const nowMs = Date.now()
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: nowMs + 60 * 60 * 1000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: null,
      rateLimitTier: 'tier-1',
    })
    clearOAuthTokenCache()
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@noumena.com',
        organizationUuid: 'org-1',
        organizationName: 'Acme',
      },
    }))

    const session = await getAuthRuntime().resolveSession({ allowRefresh: false })
    const lease = buildLocalFirstPartyLease(session, { nowMs })

    expect(lease).toMatchObject({
      leaseKind: 'local_first_party',
      state: 'usable',
      renewable: true,
      renewalOwner: 'local_runtime',
      organizationUuid: 'org-1',
    })
    expect(lease?.metadata).toMatchObject({
      principalKind: 'noumena_account',
      principalSource: 'managed_oauth',
      headersKind: 'bearer',
    })
  })
})
