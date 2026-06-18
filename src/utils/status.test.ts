import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import chalk from 'chalk'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _setGlobalConfigCacheForTesting,
  enableConfigs,
  saveGlobalConfig,
} from './config.js'
import { clearOAuthTokenCache, saveOAuthTokensIfNeeded } from './auth.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  buildAccountProperties,
  getModelDisplayLabel,
} from './status.js'
import {
  getClaudeAiUserDefaultModelDescription,
  modelDisplayString,
} from './model/model.js'

const envKeys = [
  'NODE_ENV',
  'CI',
  'IS_DEMO',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NOUMENA_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
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
  delete process.env.IS_DEMO
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
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
}

function toPropertyMap(
  properties: Array<{ label?: string; value: unknown }>,
): Map<string, unknown> {
  return new Map(
    properties
      .filter(
        (property): property is { label: string; value: unknown } =>
          typeof property.label === 'string',
      )
      .map(property => [property.label, property.value]),
  )
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-status-'))
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

describe('buildAccountProperties', () => {
  it('renders canonical managed account properties from AuthRuntime', () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
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

    const properties = toPropertyMap(buildAccountProperties())

    expect(properties.get('Login method')).toBe('Noumena Max Account')
    expect(properties.get('Auth token')).toBe('noumena_managed')
    expect(properties.get('Organization')).toBe('Acme')
    expect(properties.get('Email')).toBe('dev@noumena.com')
  })

  it('preserves demo-mode redaction through the canonical status view', () => {
    process.env.IS_DEMO = '1'
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
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

    const properties = toPropertyMap(buildAccountProperties())

    expect(properties.get('Login method')).toBe('Noumena Managed Account')
    expect(properties.has('Organization')).toBe(false)
    expect(properties.has('Email')).toBe(false)
  })

  it('renders direct API key properties without pretending they are managed auth', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    const properties = toPropertyMap(buildAccountProperties())

    expect(properties.get('API key')).toBe('NOUMENA_API_KEY')
    expect(properties.has('Login method')).toBe(false)
    expect(properties.has('Auth token')).toBe(false)
  })
})

describe('getModelDisplayLabel', () => {
  it('uses the managed-account default model description for managed sessions', () => {
    saveOAuthTokensIfNeeded({
      accessToken: 'managed-access-token',
      refreshToken: 'managed-refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-1',
    })
    clearOAuthTokenCache()

    expect(getModelDisplayLabel(null)).toBe(
      `${chalk.bold('Default')} ${getClaudeAiUserDefaultModelDescription()}`,
    )
  })

  it('keeps the generic default-model label for non-managed sessions', () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    expect(getModelDisplayLabel(null)).toBe(modelDisplayString(null))
  })
})
