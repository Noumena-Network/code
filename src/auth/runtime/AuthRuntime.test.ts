import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setFlagSettingsInline } from '../../bootstrap/state.js'
import { _setGlobalConfigCacheForTesting, enableConfigs, saveGlobalConfig } from '../../utils/config.js'
import {
  clearApiKeyHelperCache,
  clearOAuthTokenCache,
  saveApiKey,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getAuthRuntime } from './AuthRuntime.js'

const envKeys = [
  'NODE_ENV',
  'CI',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NOUMENA_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'NCODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'NCODE_REMOTE_RUNTIME_PROVIDER_MODE',
  'NCODE_REMOTE_RUNTIME_TOKEN_TRANSPORT',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_ENTRYPOINT',
  'USER_TYPE',
  'NCODE_SIMPLE',
  'CLAUDE_CODE_SIMPLE',
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
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.NCODE_REMOTE_RUNTIME_PROVIDER_MODE
  delete process.env.NCODE_REMOTE_RUNTIME_TOKEN_TRANSPORT
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.NCODE_SIMPLE
  delete process.env.CLAUDE_CODE_SIMPLE
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-auth-runtime-'))
  restoreEnv()
  setStableTestRuntime()
  enableConfigs()
  clearOAuthTokenCache()
  clearApiKeyHelperCache()
  resetSettingsCache()
  setFlagSettingsInline(null)
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
})

afterEach(async () => {
  clearOAuthTokenCache()
  clearApiKeyHelperCache()
  resetSettingsCache()
  setFlagSettingsInline(null)
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  restoreEnv()
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
  }
  tempConfigDir = ''
})

async function createApiKeyHelperScript(contents: string): Promise<string> {
  const helperPath = join(tempConfigDir, 'api-key-helper.sh')
  await writeFile(
    helperPath,
    `#!/bin/sh\nprintf '%s\\n' '${contents.replaceAll("'", "'\"'\"'")}'\n`,
    'utf8',
  )
  await chmod(helperPath, 0o700)
  return helperPath
}

describe('AuthRuntime', () => {
  it('reports expired managed auth truthfully in the canonical status view', async () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 60_000,
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

    const status = await getAuthRuntime().getStatusView()

    expect(status).toMatchObject({
      loggedIn: false,
      authMethod: 'managed_oauth_expired',
      authExpired: true,
      email: 'dev@noumena.com',
      orgId: 'org-1',
      orgName: 'Acme',
      recoveryAction: 'run_auth_login_managed',
    })
    expect(status.accountProperties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Login method',
          value: 'Noumena Managed Account (expired)',
        }),
        expect.objectContaining({
          label: 'Email',
          value: 'dev@noumena.com',
        }),
      ]),
    )
  })

  it('uses direct API-key inference auth even when stored managed auth is expired', async () => {
    process.env.NOUMENA_API_KEY = 'fallback-api-key'
    saveOAuthTokensIfNeeded({
      accessToken: 'expired-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: null,
      rateLimitTier: 'tier-1',
    })
    clearOAuthTokenCache()

    const session = getAuthRuntime().getCurrentSession()
    const managedSession = getAuthRuntime().getCurrentManagedSession()
    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(session).toMatchObject({
      principalSource: 'direct_api_key_env',
      sessionState: 'usable',
      rawApiKeySource: 'NOUMENA_API_KEY',
    })
    expect(managedSession).toMatchObject({
      principalSource: 'managed_oauth',
      sessionState: 'expired',
    })
    expect(headers).toEqual({
      'x-api-key': 'fallback-api-key',
    })
  })

  it('uses NOUMENA_API_KEY when the static API-key transport is explicit', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-static-api-key'
    process.env.NCODE_REMOTE_RUNTIME_TOKEN_TRANSPORT = 'static_api_key_env'
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: null,
      rateLimitTier: 'tier-1',
    })
    clearOAuthTokenCache()

    const session = getAuthRuntime().getCurrentSession()
    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(session).toMatchObject({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      sessionState: 'usable',
      headersKind: 'api_key',
      providerAuthKind: 'noumena_first_party',
      rawApiKeySource: 'NOUMENA_API_KEY',
      providerPlan: {
        mode: 'noumena_managed',
        source: 'direct_api_key_env',
        staticKeyEnvVarName: 'NOUMENA_API_KEY',
      },
    })
    expect(headers).toEqual({
      'x-api-key': 'noumena-static-api-key',
    })
  })

  it('builds bearer first-party headers for injected service oauth tokens', async () => {
    process.env.NCODE_OAUTH_TOKEN = 'service-token'

    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(headers).toMatchObject({
      Authorization: 'Bearer service-token',
      'anthropic-beta': 'oauth-2025-04-20',
    })
  })

  it('builds bearer first-party headers for external bearer compat sessions', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'external-bearer-token'

    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(headers).toEqual({
      Authorization: 'Bearer external-bearer-token',
      'anthropic-beta': 'oauth-2025-04-20',
    })
  })

  it('reports direct API key sessions without pretending they are managed auth', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    const status = await getAuthRuntime().getStatusView()
    const session = getAuthRuntime().getCurrentSession()

    expect(status).toMatchObject({
      loggedIn: true,
      authMethod: 'api_key',
      apiKeySource: 'NOUMENA_API_KEY',
      authExpired: false,
    })
    expect(session.providerPlan).toMatchObject({
      mode: 'noumena_managed',
      source: 'direct_api_key_env',
      staticKeyEnvVarName: 'NOUMENA_API_KEY',
    })
    expect(status.accountProperties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'API key',
          value: 'NOUMENA_API_KEY',
        }),
      ]),
    )
  })

  it('builds API-key headers by default for canonical direct API key sessions', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(headers).toEqual({
      'x-api-key': 'noumena-api-key',
    })
  })

  it('persists managed OAuth tokens through the canonical runtime helper', () => {
    const authRuntime = getAuthRuntime()

    const result = authRuntime.persistOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'tier-1',
    })

    expect(result).toMatchObject({ success: true })
    expect(authRuntime.getCurrentManagedRefreshToken()).toBe(
      'managed-refresh-token',
    )
  })

  it('recovers managed OAuth 401s through the canonical runtime helper when storage already has a newer token', async () => {
    const authRuntime = getAuthRuntime()

    authRuntime.persistOAuthTokensIfNeeded({
      accessToken: 'fresh-managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'tier-1',
    })

    await expect(
      authRuntime.recoverManagedOAuth401('stale-managed-access-token'),
    ).resolves.toBe(true)
  })

  it('removes stored console API keys through the canonical runtime helper', async () => {
    await saveApiKey('stored-console-api-key')

    expect(getAuthRuntime().getCurrentSession()).toMatchObject({
      principalSource: 'console_api_key',
      hasUsableApiKey: true,
    })

    await getAuthRuntime().removeStoredApiKey()

    expect(getAuthRuntime().getCurrentSession()).toMatchObject({
      principalSource: 'none',
      hasUsableApiKey: false,
    })
  })

  it('persists stored console API keys through the canonical runtime helper', async () => {
    try {
      await getAuthRuntime().persistStoredApiKey('stored-console-api-key')

      expect(getAuthRuntime().getCurrentSession()).toMatchObject({
        principalSource: 'console_api_key',
        hasUsableApiKey: true,
        apiKey: 'stored-console-api-key',
      })
    } finally {
      await getAuthRuntime().removeStoredApiKey()
    }
  })

  it('returns a direct API key principal snapshot synchronously', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    const session = getAuthRuntime().getCurrentSession()

    expect(session).toMatchObject({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      sessionState: 'usable',
      headersKind: 'api_key',
      providerAuthKind: 'noumena_first_party',
      hasUsableApiKey: true,
      providerPlan: {
        mode: 'noumena_managed',
        source: 'direct_api_key_env',
        staticKeyEnvVarName: 'NOUMENA_API_KEY',
      },
    })
  })

  it('keeps ANTHROPIC_API_KEY as a supported static BYOK env-key provider path', async () => {
    delete process.env.NOUMENA_API_KEY
    process.env.ANTHROPIC_API_KEY = 'anthropic-direct-key'

    const session = getAuthRuntime().getCurrentSession()
    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(session).toMatchObject({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      sessionState: 'usable',
      providerAuthKind: 'byok_static_env',
      providerPlan: {
        mode: 'byok_static_env',
        source: 'direct_api_key_env',
        staticKeyEnvVarName: 'ANTHROPIC_API_KEY',
      },
      rawApiKeySource: 'ANTHROPIC_API_KEY',
    })
    expect(headers).toEqual({
      'x-api-key': 'anthropic-direct-key',
    })
  })

  it('keeps OPENAI_API_KEY as OpenAI-compatible BYOK without first-party headers', async () => {
    delete process.env.NOUMENA_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = 'openai-direct-key'

    const session = getAuthRuntime().getCurrentSession()
    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(session).toMatchObject({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      sessionState: 'usable',
      headersKind: 'none',
      providerAuthKind: 'byok_static_env',
      providerPlan: {
        mode: 'byok_static_env',
        source: 'direct_api_key_env',
        staticKeyEnvVarName: 'OPENAI_API_KEY',
      },
      rawApiKeySource: 'OPENAI_API_KEY',
      hasUsableApiKey: true,
      apiKey: 'openai-direct-key',
    })
    expect(headers).toEqual({})
  })

  it('warms apiKeyHelper-backed sessions before status and header resolution', async () => {
    const helperPath = await createApiKeyHelperScript('helper-api-key')
    setFlagSettingsInline({ apiKeyHelper: helperPath })
    resetSettingsCache()

    const status = await getAuthRuntime().getStatusView()
    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(status).toMatchObject({
      loggedIn: true,
      authMethod: 'api_key_helper',
      apiKeySource: 'apiKeyHelper',
      authExpired: false,
    })
    expect(headers).toEqual({
      Authorization: 'Bearer helper-api-key',
      'anthropic-beta': 'oauth-2025-04-20',
    })
  })

  it('warms bare-mode apiKeyHelper-backed sessions before status and header resolution', async () => {
    const helperPath = await createApiKeyHelperScript('bare-helper-api-key')
    process.env.NCODE_SIMPLE = '1'
    setFlagSettingsInline({ apiKeyHelper: helperPath })
    resetSettingsCache()

    const status = await getAuthRuntime().getStatusView()
    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(status).toMatchObject({
      loggedIn: true,
      authMethod: 'api_key_helper',
      apiKeySource: 'apiKeyHelper',
      authExpired: false,
    })
    expect(headers).toEqual({
      Authorization: 'Bearer bare-helper-api-key',
      'anthropic-beta': 'oauth-2025-04-20',
    })
  })

  it('surfaces the stored managed session separately from direct env API-key precedence', () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-direct-key'
    getSecureStorage().update({
      claudeAiOauth: {
        accessToken: 'managed-access-token',
        refreshToken: 'managed-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:profile'],
        subscriptionType: 'pro',
        rateLimitTier: 'tier-1',
      },
    })
    clearOAuthTokenCache()

    const session = getAuthRuntime().getCurrentSession()
    const managedSession = getAuthRuntime().getCurrentManagedSession()

    expect(session).toMatchObject({
      principalSource: 'direct_api_key_env',
      providerAuthKind: 'byok_static_env',
    })
    expect(managedSession).toMatchObject({
      principalSource: 'managed_oauth',
      sessionState: 'usable',
      accessToken: 'managed-access-token',
      scopes: ['user:profile'],
    })
    expect(getAuthRuntime().getCurrentManagedRefreshToken()).toBe(
      'managed-refresh-token',
    )
  })

  it('surfaces the stored managed session separately from OpenAI BYOK inference auth', () => {
    process.env.OPENAI_API_KEY = 'openai-direct-key'
    getSecureStorage().update({
      claudeAiOauth: {
        accessToken: 'managed-access-token',
        refreshToken: 'managed-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:profile'],
        subscriptionType: 'pro',
        rateLimitTier: 'tier-1',
      },
    })
    clearOAuthTokenCache()

    const session = getAuthRuntime().getCurrentSession()
    const managedSession = getAuthRuntime().getCurrentManagedSession()

    expect(session).toMatchObject({
      principalSource: 'direct_api_key_env',
      headersKind: 'none',
      providerAuthKind: 'byok_static_env',
      rawApiKeySource: 'OPENAI_API_KEY',
    })
    expect(managedSession).toMatchObject({
      principalSource: 'managed_oauth',
      sessionState: 'usable',
      accessToken: 'managed-access-token',
      scopes: ['user:profile'],
    })
  })

  it('prefers static BYOK env-key auth over injected remote OAuth when the remote lease is BYOK', async () => {
    process.env.NCODE_OAUTH_TOKEN = 'remote-managed-token'
    process.env.NCODE_REMOTE_RUNTIME_PROVIDER_MODE = 'byok'
    process.env.NCODE_REMOTE_RUNTIME_TOKEN_TRANSPORT = 'static_api_key_env'
    process.env.ANTHROPIC_API_KEY = 'byok-static-key'

    const session = getAuthRuntime().getCurrentSession()
    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(session).toMatchObject({
      principalSource: 'direct_api_key_env',
      providerAuthKind: 'byok_static_env',
      rawApiKeySource: 'ANTHROPIC_API_KEY',
    })
    expect(headers).toEqual({
      'x-api-key': 'byok-static-key',
    })
  })

  it('does not surface a managed refresh token for non-managed sessions', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    expect(getAuthRuntime().getCurrentManagedRefreshToken()).toBeNull()
  })

  it('does not treat session ingress tokens as canonical principal auth', async () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'session-env-token'

    const status = await getAuthRuntime().getStatusView()
    const headers = await getAuthRuntime().buildFirstPartyHeaders()

    expect(status).toMatchObject({
      loggedIn: false,
      authMethod: 'none',
      authExpired: false,
      apiKeySource: null,
      authTokenSource: null,
      recoveryAction: 'run_auth_login',
    })
    expect(headers).toEqual({})
  })

  it('does not surface session ingress as a synchronous principal session', () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'session-env-token'

    const session = getAuthRuntime().getCurrentSession()

    expect(session).toMatchObject({
      principalKind: 'none',
      principalSource: 'none',
      sessionState: 'unauthenticated',
      headersKind: 'none',
      accessToken: 'session-env-token',
      hasUsableToken: true,
      scopes: ['user:inference'],
    })
  })

  it('does not surface stale first-party account metadata for third-party provider sessions', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-stale',
        emailAddress: 'stale@noumena.test',
        organizationUuid: 'org-stale',
        organizationName: 'Stale Org',
      },
    }))

    const session = getAuthRuntime().getCurrentSession()
    const status = await getAuthRuntime().getStatusView()

    expect(session).toMatchObject({
      principalKind: 'third_party_provider',
      principalSource: 'third_party_provider',
      providerPlan: {
        mode: 'third_party_provider',
      },
      identity: {
        email: null,
        accountUuid: null,
        organizationUuid: null,
        organizationName: null,
      },
    })
    expect(status).toMatchObject({
      loggedIn: true,
      authMethod: 'third_party',
      email: null,
      orgId: null,
      orgName: null,
    })
  })
})
