import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { authLogin, authStatus, installOAuthTokens } from './auth.js'
import { clearOAuthTokenCache, saveOAuthTokensIfNeeded } from '../../utils/auth.js'
import {
  _setGlobalConfigCacheForTesting,
  enableConfigs,
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'

let tempConfigDir = ''
const getCalls: Array<{ url: string; options?: unknown }> = []
const postCalls: Array<{ url: string; body?: unknown; options?: unknown }> = []

const originalAxiosGet = axios.get
const originalAxiosPost = axios.post
const originalMacro = (globalThis as { MACRO?: unknown }).MACRO
const originalProcessExit = process.exit
const originalStdoutWrite = process.stdout.write.bind(process.stdout)
const originalStderrWrite = process.stderr.write.bind(process.stderr)
const envKeys = [
  'NODE_ENV',
  'CI',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NOUMENA_PLATFORM_BASE_URL',
  'NOUMENA_ISSUER_BASE_URL',
  'ANTHROPIC_API_KEY',
  'NOUMENA_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_ENTRYPOINT',
  'USER_TYPE',
] as const
const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

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
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'managed-session-token'
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.NOUMENA_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.USER_TYPE = 'test'

  ;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = {
    ...(typeof originalMacro === 'object' && originalMacro !== null
      ? (originalMacro as Record<string, unknown>)
      : {}),
    VERSION: 'test-version',
  }
}

function makeTokens(scopes: string[]) {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 60_000,
    scopes,
    subscriptionType: null,
    rateLimitTier: null,
    profile: {
      account: {
        uuid: 'acct-1',
        email: 'dev@noumena.com',
        display_name: 'Dev',
        created_at: '2026-04-14T00:00:00.000Z',
      },
      organization: {
        uuid: 'org-1',
        organization_type: 'workspace',
        has_extra_usage_enabled: false,
        billing_type: null,
        subscription_created_at: null,
      },
    },
  }
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-auth-install-'))
  restoreEnv()
  setStableTestRuntime()
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  getCalls.length = 0
  postCalls.length = 0

  axios.get = (async (url: string, options?: unknown) => {
    getCalls.push({ url, options })
    const pathname = new URL(url).pathname
    if (pathname === '/api/oauth/ncode/roles') {
      return {
        data: {
          organization_role: 'owner',
          workspace_role: 'admin',
          organization_name: 'Acme',
        },
      }
    }
    if (pathname === '/api/organization/claude_code_first_token_date') {
      return {
        data: {
          first_token_date: '2026-01-02T00:00:00.000Z',
        },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  }) as typeof axios.get

  axios.post = (async (url: string, body?: unknown, options?: unknown) => {
    postCalls.push({ url, body, options })
    const pathname = new URL(url).pathname
    if (pathname === '/api/oauth/ncode/create_api_key') {
      return {
        data: { raw_key: 'sk-test' },
        status: 200,
      }
    }
    throw new Error(`Unexpected POST ${url}`)
  }) as typeof axios.post
})

afterEach(async () => {
  axios.get = originalAxiosGet
  axios.post = originalAxiosPost
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  restoreEnv()
  ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
  process.exit = originalProcessExit
  process.stdout.write = originalStdoutWrite
  process.stderr.write = originalStderrWrite
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
  }
  tempConfigDir = ''
})

describe('installOAuthTokens', () => {
  it('uses explicit managed mode even when scopes do not imply managed auth', async () => {
    await installOAuthTokens(makeTokens([]), { mode: 'managed' })

    expect(getGlobalConfig().oauthAccount).toMatchObject({
      accountUuid: 'acct-1',
      emailAddress: 'dev@noumena.com',
      organizationUuid: 'org-1',
      displayName: 'Dev',
    })
    expect(getGlobalConfig().primaryApiKey).toBeUndefined()
    expect(postCalls).toEqual([])
    expect(getCalls).toEqual([])
  })

  it('uses explicit console mode even when scopes include user:inference', async () => {
    await installOAuthTokens(makeTokens(['user:inference']), {
      mode: 'console',
    })

    expect(getGlobalConfig().oauthAccount).toMatchObject({
      accountUuid: 'acct-1',
      emailAddress: 'dev@noumena.com',
      organizationUuid: 'org-1',
      organizationRole: 'owner',
      workspaceRole: 'admin',
      organizationName: 'Acme',
    })
    expect(getGlobalConfig().primaryApiKey).toBe('sk-test')
    expect(getSecureStorage().read()?.claudeAiOauth).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      scopes: ['user:inference'],
    })
    expect(getCalls.map(call => new URL(call.url).pathname)).toEqual([
      '/api/oauth/ncode/roles',
    ])
    expect(postCalls.map(call => new URL(call.url).pathname)).toEqual([
      '/api/oauth/ncode/create_api_key',
    ])
  })

  it('keeps auto mode scope-derived for compatibility', async () => {
    await installOAuthTokens(makeTokens(['user:inference']))

    expect(getGlobalConfig().primaryApiKey).toBeUndefined()
    expect(getSecureStorage().read()?.claudeAiOauth).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      scopes: ['user:inference'],
    })
    expect(getCalls).toEqual([])
    expect(postCalls).toEqual([])
  })

  it('fails managed mode when the issuer returns a stub identity', async () => {
    const tokens = makeTokens(['user:inference'])
    tokens.profile = {
      account: {
        uuid: 'acct_stub',
        email: 'stub@noumena.invalid',
        display_name: 'Stub',
        created_at: '2026-04-14T00:00:00.000Z',
      },
      organization: {
        uuid: '00000000-0000-4000-8000-000000000002',
        organization_type: 'workspace',
        has_extra_usage_enabled: false,
        billing_type: null,
        subscription_created_at: null,
      },
    }

    await expect(
      installOAuthTokens(tokens, { mode: 'managed' }),
    ).rejects.toThrow(
      'Managed OAuth login returned a stub Noumena identity. Remote sessions require a real account and organization binding.',
    )

    expect(getSecureStorage().read()?.claudeAiOauth).toBeUndefined()
    expect(getGlobalConfig().oauthAccount).toBeUndefined()
    expect(getCalls).toEqual([])
    expect(postCalls).toEqual([])
  })
})

describe('authLogin', () => {
  it('rejects conflicting console and managed flags', async () => {
    const errors: string[] = []
    const originalConsoleError = console.error
    console.error = ((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }) as typeof console.error

    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`)
    }) as typeof process.exit

    try {
      await expect(
        authLogin({
          console: true,
          managed: true,
        }),
      ).rejects.toThrow('exit:1')
      expect(errors.join('')).toContain(
        'Error: --console and --managed cannot be used together.',
      )
    } finally {
      console.error = originalConsoleError
    }
  })
})

describe('authStatus', () => {
  it('reports expired managed oauth truthfully in text mode and exits nonzero', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN

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

    const stdout: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`)
    }) as typeof process.exit

    await expect(authStatus({ text: true })).rejects.toThrow('exit:1')

    const output = stdout.join('')
    expect(output).toContain('Login method: Noumena Managed Account (expired)')
    expect(output).toContain('Email: dev@noumena.com')
    expect(output).toContain('Continuity: Degraded')
    expect(output).toContain('Lease renewal: Degraded')
    expect(output).toContain('Execution: Local')
    expect(output).toContain(
      'Managed OAuth expired. Run auth login --managed to re-authenticate.',
    )
  })

  it('reports expired managed oauth truthfully in json mode and exits nonzero', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN

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

    const stdout: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`)
    }) as typeof process.exit

    await expect(authStatus({ json: true })).rejects.toThrow('exit:1')

    expect(JSON.parse(stdout.join(''))).toMatchObject({
      loggedIn: false,
      authMethod: 'managed_oauth_expired',
      authExpired: true,
      email: 'dev@noumena.com',
      orgId: 'org-1',
      orgName: 'Acme',
      continuityState: 'degraded',
      leaseRenewalState: 'degraded',
      executionTarget: 'local',
      leaseKind: 'local_first_party',
      leaseState: 'expired',
    })
  })
})
