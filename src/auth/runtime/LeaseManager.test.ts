import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setFlagSettingsInline } from '../../bootstrap/state.js'
import {
  _setGlobalConfigCacheForTesting,
  enableConfigs,
  saveGlobalConfig,
} from '../../utils/config.js'
import {
  clearApiKeyHelperCache,
  clearOAuthTokenCache,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getLeaseManager } from './LeaseManager.js'

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
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.NCODE_SIMPLE
  delete process.env.CLAUDE_CODE_SIMPLE
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-lease-manager-'))
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

describe('LeaseManager', () => {
  it('resolves and caches a local first-party lease for managed auth sessions', async () => {
    const nowMs = Date.now()
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: nowMs + 60 * 60 * 1000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'tier-1',
    })
    clearOAuthTokenCache()
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-lease',
        emailAddress: 'lease@noumena.com',
        organizationUuid: 'org-lease',
        organizationName: 'Lease Org',
      },
    }))

    const lease = await getLeaseManager().resolveLease({ nowMs })

    expect(lease).not.toBeNull()
    expect(lease).toMatchObject({
      leaseKind: 'local_first_party',
      state: 'usable',
      renewable: true,
      renewalOwner: 'local_runtime',
      executionTarget: 'local',
      providerMode: 'noumena_managed',
      organizationUuid: 'org-lease',
    })
    expect(getLeaseManager().getCachedLease()).toEqual(lease)
  })

  it('returns an unrenewable local first-party lease for direct API-key sessions', async () => {
    process.env.NOUMENA_API_KEY = 'direct-api-key'
    const nowMs = Date.now()

    const lease = await getLeaseManager().resolveLease({ nowMs })

    expect(lease).not.toBeNull()
    expect(lease).toMatchObject({
      leaseKind: 'local_first_party',
      state: 'usable',
      renewable: false,
      renewalOwner: 'none',
      executionTarget: 'local',
      providerMode: 'noumena_managed',
    })
    expect(lease?.metadata).toMatchObject({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      hasUsableApiKey: true,
    })
  })

  it('returns an unrenewable local BYOK lease for static ANTHROPIC_API_KEY sessions', async () => {
    delete process.env.NOUMENA_API_KEY
    process.env.ANTHROPIC_API_KEY = 'anthropic-direct-key'
    const nowMs = Date.now()

    const lease = await getLeaseManager().resolveLease({ nowMs })

    expect(lease).not.toBeNull()
    expect(lease).toMatchObject({
      leaseKind: 'local_first_party',
      state: 'usable',
      renewable: false,
      renewalOwner: 'none',
      executionTarget: 'local',
      providerMode: 'byok',
    })
    expect(lease?.metadata).toMatchObject({
      principalKind: 'api_key_user',
      principalSource: 'direct_api_key_env',
      hasUsableApiKey: true,
    })
  })

  it('returns a healthy local lease for apiKeyHelper-backed sessions after warming the canonical runtime', async () => {
    const helperPath = await createApiKeyHelperScript('helper-api-key')
    setFlagSettingsInline({ apiKeyHelper: helperPath })
    resetSettingsCache()
    const nowMs = Date.now()

    const lease = await getLeaseManager().resolveLease({ nowMs })

    expect(lease).not.toBeNull()
    expect(lease).toMatchObject({
      leaseKind: 'local_first_party',
      state: 'usable',
      renewable: false,
      renewalOwner: 'none',
      executionTarget: 'local',
      providerMode: 'noumena_managed',
    })
    expect(lease?.metadata).toMatchObject({
      principalKind: 'api_key_user',
      principalSource: 'api_key_helper',
      hasUsableApiKey: true,
    })
  })

  it('builds a healthy continuity status view for managed auth sessions with a usable lease', async () => {
    const nowMs = Date.now()
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: nowMs + 60 * 60 * 1000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'tier-1',
    })
    clearOAuthTokenCache()
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: {
        accountUuid: 'acct-continuity',
        emailAddress: 'continuity@noumena.com',
        organizationUuid: 'org-continuity',
        organizationName: 'Continuity Org',
      },
    }))

    const status = await getLeaseManager().getStatusView({ nowMs })

    expect(status).toMatchObject({
      principalKind: 'noumena_account',
      principalSource: 'managed_oauth',
      sessionState: 'usable',
      leaseKind: 'local_first_party',
      leaseState: 'usable',
      executionTarget: 'local',
      providerMode: 'noumena_managed',
      continuityState: 'healthy',
      leaseRenewalState: 'healthy',
      renewable: true,
      recoveryAction: 'none',
    })
  })

  it('reports unavailable continuity for session-ingress-only auth state', async () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'session-env-token'

    const status = await getLeaseManager().getStatusView({ nowMs: Date.now() })

    expect(status).toMatchObject({
      principalKind: 'none',
      principalSource: 'none',
      continuityState: 'unavailable',
      leaseRenewalState: 'not_applicable',
      leaseKind: null,
      leaseState: null,
      renewable: false,
      recoveryAction: 'run_auth_login',
    })
  })
})
