import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getGlobalConfig,
  saveGlobalConfig,
  enableConfigs,
  _setGlobalConfigCacheForTesting,
} from '../../utils/config.js'
import { clearOAuthTokenCache, saveOAuthTokensIfNeeded } from '../../utils/auth.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import {
  buildManagedRemoteRuntimeLeaseEnvironmentVariables,
  hasManagedRemoteCommandPrincipal,
  hasUsableManagedRemotePrincipal,
  hasManagedRemoteBootstrapAuth,
  isExpiredManagedRemoteBootstrapSession,
  MANAGED_REMOTE_AUTH_REQUIRED_MESSAGE,
  persistManagedRemoteBootstrapFailure,
  refreshManagedRemoteRuntimeAccessToken,
  resolveManagedRemoteCapability,
  resolveManagedRemoteBootstrapCapability,
  resolveManagedRemoteRuntimeAuth,
  resolveManagedRemoteRuntimeAuthFromCallbacks,
  resolveManagedRemoteRuntimeLease,
  shouldSkipManagedRemoteBootstrapBackoff,
} from './remote.js'
import { getAuthRuntime } from '../runtime/AuthRuntime.js'

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
  'NOUMENA_OAUTH_CLIENT_ID',
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
  process.env.NOUMENA_OAUTH_CLIENT_ID = 'noumena-code-test'
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
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-remote-capability-'))
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

describe('remote auth capability', () => {
  it('treats managed oauth with inference scope as a remote-command principal', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()

    expect(
      hasManagedRemoteCommandPrincipal(getAuthRuntime().getCurrentSession()),
    ).toBe(true)
  })

  it('rejects direct API-key sessions as remote-command principals', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    expect(
      hasManagedRemoteCommandPrincipal(getAuthRuntime().getCurrentSession()),
    ).toBe(false)
  })

  it('resolves a managed remote capability from the canonical auth runtime', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
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

    const capability = await resolveManagedRemoteCapability()

    expect(capability).toMatchObject({
      accessToken: 'managed-access-token',
      orgUUID: 'org-1',
      session: {
        principalSource: 'managed_oauth',
        sessionState: 'usable',
      },
    })
  })

  it('rejects direct API key sessions for managed remote capability resolution', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    await expect(resolveManagedRemoteCapability()).rejects.toThrow(
      MANAGED_REMOTE_AUTH_REQUIRED_MESSAGE,
    )
  })

  it('allows an explicit compat access-token override while keeping org resolution centralized', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@noumena.com',
        organizationUuid: 'org-override',
        organizationName: 'Acme',
      },
    }))

    const capability = await resolveManagedRemoteCapability({
      accessTokenOverride: 'override-access-token',
    })

    expect(capability.accessToken).toBe('override-access-token')
    expect(capability.orgUUID).toBe('org-override')
    expect(capability.session.identity.organizationUuid).toBe('org-override')
  })

  it('uses the shared bootstrap capability seam for bridge-compatible override flows', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@noumena.com',
        organizationUuid: 'org-override',
        organizationName: 'Acme',
      },
    }))

    const capability = await resolveManagedRemoteBootstrapCapability({
      accessTokenOverride: 'override-access-token',
    })

    expect(capability.accessToken).toBe('override-access-token')
    expect(capability.orgUUID).toBe('org-override')
  })

  it('builds a runtime-managed bridge auth handle for managed sessions', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token-1',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@noumena.com',
        organizationUuid: 'org-runtime',
        organizationName: 'Acme',
      },
    }))

    const runtimeAuth = await resolveManagedRemoteRuntimeAuth()
    expect(runtimeAuth.orgUUID).toBe('org-runtime')
    expect(runtimeAuth.getAccessToken()).toBe('managed-access-token-1')

    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token-2',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()

    expect(runtimeAuth.getAccessToken()).toBe('managed-access-token-2')
  })

  it('preserves override-backed runtime bridge auth handles', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@noumena.com',
        organizationUuid: 'org-override',
        organizationName: 'Acme',
      },
    }))

    const runtimeAuth = await resolveManagedRemoteRuntimeAuth({
      accessTokenOverride: 'override-access-token',
    })

    expect(runtimeAuth.orgUUID).toBe('org-override')
    expect(runtimeAuth.getAccessToken()).toBe('override-access-token')
    expect(await runtimeAuth.refreshAccessToken()).toBe(
      'override-access-token',
    )
  })

  it('builds callback-backed runtime bridge auth handles without requiring a canonical managed principal', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@noumena.com',
        organizationUuid: 'org-callback',
        organizationName: 'Acme',
      },
    }))

    let currentToken = 'callback-managed-token-1'
    const staleTokens: string[] = []

    const runtimeAuth = await resolveManagedRemoteRuntimeAuthFromCallbacks({
      getAccessToken: () => currentToken,
      onAuth401: async staleAccessToken => {
        staleTokens.push(staleAccessToken)
        currentToken = 'callback-managed-token-2'
        return true
      },
    })

    expect(runtimeAuth.orgUUID).toBe('org-callback')
    expect(runtimeAuth.getAccessToken()).toBe('callback-managed-token-1')
    expect(await runtimeAuth.refreshAccessToken()).toBe(
      'callback-managed-token-2',
    )
    expect(staleTokens).toEqual(['callback-managed-token-1'])
  })

  it('refreshes managed remote runtime auth through the shared refresh helper', async () => {
    let currentToken = 'managed-access-token-1'
    const staleTokens: string[] = []

    const refreshedToken = await refreshManagedRemoteRuntimeAccessToken({
      getAccessToken: () => currentToken,
      onAuth401: async staleAccessToken => {
        staleTokens.push(staleAccessToken)
        currentToken = 'managed-access-token-2'
        return true
      },
    })

    expect(staleTokens).toEqual(['managed-access-token-1'])
    expect(refreshedToken).toBe('managed-access-token-2')
  })

  it('falls back to the stale managed remote runtime token when refresh does not replace it', async () => {
    const refreshedToken = await refreshManagedRemoteRuntimeAccessToken({
      getAccessToken: () => 'managed-access-token-1',
      onAuth401: async () => false,
    })

    expect(refreshedToken).toBe('managed-access-token-1')
  })

  it('issues an explicit remote runtime lease for managed sessions', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@noumena.com',
        organizationUuid: 'org-runtime-lease',
        organizationName: 'Acme',
      },
    }))

    const runtimeLease = await resolveManagedRemoteRuntimeLease()

    expect(runtimeLease.accessToken).toBe('managed-access-token')
    expect(runtimeLease.orgUUID).toBe('org-runtime-lease')
    expect(runtimeLease.lease).toMatchObject({
      leaseKind: 'remote_session',
      state: 'usable',
      renewable: false,
      renewalOwner: 'none',
      executionTarget: 'remote',
      providerMode: 'noumena_managed',
      organizationUuid: 'org-runtime-lease',
    })
    expect(runtimeLease.lease.metadata).toMatchObject({
      tokenTransport: 'oauth_env',
      accessTokenEnvVarName: 'NCODE_OAUTH_TOKEN',
    })
  })

  it('renders remote runtime lease env vars with the canonical oauth transport', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@noumena.com',
        organizationUuid: 'org-runtime-lease',
        organizationName: 'Acme',
      },
    }))

    const runtimeLease = await resolveManagedRemoteRuntimeLease()
    const envVars = buildManagedRemoteRuntimeLeaseEnvironmentVariables({
      runtimeLease,
      baseEnvironmentVariables: {
        NOUMENA_MODEL: 'kimi-k2.6',
      },
    })

    expect(envVars).toMatchObject({
      NOUMENA_MODEL: 'kimi-k2.6',
      NCODE_OAUTH_TOKEN: 'managed-access-token',
      NCODE_REMOTE_RUNTIME_LEASE_KIND: 'remote_session',
      NCODE_REMOTE_RUNTIME_EXECUTION_TARGET: 'remote',
      NCODE_REMOTE_RUNTIME_PROVIDER_MODE: 'noumena_managed',
      NCODE_REMOTE_RUNTIME_RENEWABLE: '0',
      NCODE_REMOTE_RUNTIME_RENEWAL_OWNER: 'none',
      NCODE_REMOTE_RUNTIME_TOKEN_TRANSPORT: 'oauth_env',
      NCODE_REMOTE_RUNTIME_ORGANIZATION_UUID: 'org-runtime-lease',
    })
    expect(envVars.NCODE_REMOTE_RUNTIME_LEASE_ID).toContain('remote_session:')
  })

  it('renders remote BYOK runtime env vars when managed control-plane auth has a static provider key', async () => {
    process.env.ANTHROPIC_API_KEY = 'byok-static-key'
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@noumena.com',
        organizationUuid: 'org-runtime-lease',
        organizationName: 'Acme',
      },
    }))

    const runtimeLease = await resolveManagedRemoteRuntimeLease()
    const envVars = buildManagedRemoteRuntimeLeaseEnvironmentVariables({
      runtimeLease,
    })

    expect(runtimeLease.lease.providerMode).toBe('byok')
    expect(envVars).toMatchObject({
      ANTHROPIC_API_KEY: 'byok-static-key',
      NCODE_REMOTE_RUNTIME_PROVIDER_MODE: 'byok',
      NCODE_REMOTE_RUNTIME_TOKEN_TRANSPORT: 'static_api_key_env',
      NCODE_REMOTE_RUNTIME_ORGANIZATION_UUID: 'org-runtime-lease',
    })
    expect(envVars.NCODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('recognizes usable managed remote principals only for full-scope managed sessions', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'
    const apiKeySession = getAuthRuntime().getCurrentSession()
    expect(hasUsableManagedRemotePrincipal(apiKeySession)).toBe(false)

    delete process.env.NOUMENA_API_KEY
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()
    const managedSession = getAuthRuntime().getCurrentSession()
    expect(hasUsableManagedRemotePrincipal(managedSession)).toBe(true)
  })

  it('treats managed sessions or explicit overrides as valid remote bootstrap auth', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'
    const apiKeySession = getAuthRuntime().getCurrentSession()
    expect(
      hasManagedRemoteBootstrapAuth({
        session: apiKeySession,
      }),
    ).toBe(false)
    expect(
      hasManagedRemoteBootstrapAuth({
        accessTokenOverride: 'override-access-token',
        session: apiKeySession,
      }),
    ).toBe(true)

    delete process.env.NOUMENA_API_KEY
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()
    const managedSession = getAuthRuntime().getCurrentSession()
    expect(
      hasManagedRemoteBootstrapAuth({
        session: managedSession,
      }),
    ).toBe(true)
  })

  it('tracks expired managed bootstrap sessions with the cross-process backoff state', () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'expired-managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier_1',
    })
    clearOAuthTokenCache()

    const expiredSession = getAuthRuntime().getCurrentSession()
    expect(isExpiredManagedRemoteBootstrapSession(expiredSession)).toBe(true)
    expect(shouldSkipManagedRemoteBootstrapBackoff(expiredSession)).toBe(false)

    expect(persistManagedRemoteBootstrapFailure(expiredSession)).toBe(true)
    expect(getGlobalConfig().bridgeOauthDeadFailCount).toBe(1)
    expect(getGlobalConfig().bridgeOauthDeadExpiresAt).toBe(
      expiredSession.accessTokenExpiresAt,
    )

    saveGlobalConfig(current => ({
      ...current,
      bridgeOauthDeadFailCount: 3,
      bridgeOauthDeadExpiresAt: expiredSession.accessTokenExpiresAt,
    }))

    expect(shouldSkipManagedRemoteBootstrapBackoff(expiredSession)).toBe(true)
  })
})
