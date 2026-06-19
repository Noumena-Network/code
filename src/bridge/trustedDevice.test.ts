import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import axios from 'axios'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetGrowthBook } from '../services/analytics/growthbook.js'
import { clearOAuthTokenCache } from '../utils/auth.js'
import {
  clearTrustedDeviceToken,
  clearTrustedDeviceTokenCache,
  enrollTrustedDevice,
  getTrustedDeviceToken,
} from './trustedDevice.js'

let configDir: string

const originalAxiosPost = axios.post
const originalNcodeConfigDir = process.env.NCODE_CONFIG_DIR
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalFcOverrides = process.env.CLAUDE_INTERNAL_FC_OVERRIDES
const originalNoumenaPlatformBaseUrl = process.env.NOUMENA_PLATFORM_BASE_URL
const originalTrustedDeviceToken = process.env.CLAUDE_TRUSTED_DEVICE_TOKEN
const originalUserType = process.env.USER_TYPE

const TRUSTED_DEVICE_GATE = 'ncode_sessions_elevated_auth_enforcement'

function credentialsPath(): string {
  return join(configDir, '.credentials.json')
}

async function writeCredentials(data: Record<string, unknown>): Promise<void> {
  await writeFile(credentialsPath(), JSON.stringify(data), 'utf8')
  clearOAuthTokenCache()
  clearTrustedDeviceTokenCache()
}

async function readCredentials(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(credentialsPath(), 'utf8')) as Record<
    string,
    unknown
  >
}

function setTrustedDeviceGate(enabled: boolean): void {
  process.env.CLAUDE_INTERNAL_FC_OVERRIDES = JSON.stringify({
    [TRUSTED_DEVICE_GATE]: enabled,
  })
  resetGrowthBook()
  clearTrustedDeviceTokenCache()
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'trusted-device-'))

  process.env.NCODE_CONFIG_DIR = configDir
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.USER_TYPE = 'ant'
  process.env.NOUMENA_PLATFORM_BASE_URL = 'https://platform.example'
  setTrustedDeviceGate(true)
  delete process.env.CLAUDE_TRUSTED_DEVICE_TOKEN
})

afterEach(async () => {
  axios.post = originalAxiosPost
  resetGrowthBook()
  clearOAuthTokenCache()
  clearTrustedDeviceTokenCache()

  if (originalNcodeConfigDir === undefined) {
    delete process.env.NCODE_CONFIG_DIR
  } else {
    process.env.NCODE_CONFIG_DIR = originalNcodeConfigDir
  }

  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }

  if (originalFcOverrides === undefined) {
    delete process.env.CLAUDE_INTERNAL_FC_OVERRIDES
  } else {
    process.env.CLAUDE_INTERNAL_FC_OVERRIDES = originalFcOverrides
  }

  if (originalNoumenaPlatformBaseUrl === undefined) {
    delete process.env.NOUMENA_PLATFORM_BASE_URL
  } else {
    process.env.NOUMENA_PLATFORM_BASE_URL = originalNoumenaPlatformBaseUrl
  }

  if (originalTrustedDeviceToken === undefined) {
    delete process.env.CLAUDE_TRUSTED_DEVICE_TOKEN
  } else {
    process.env.CLAUDE_TRUSTED_DEVICE_TOKEN = originalTrustedDeviceToken
  }

  if (originalUserType === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalUserType
  }

  await rm(configDir, { recursive: true, force: true })
})

describe('trustedDevice', () => {
  it('prefers the env token over storage and returns nothing when the gate is off', async () => {
    await writeCredentials({ trustedDeviceToken: 'stored-token' })

    expect(getTrustedDeviceToken()).toBe('stored-token')

    process.env.CLAUDE_TRUSTED_DEVICE_TOKEN = 'env-token'
    clearTrustedDeviceTokenCache()
    expect(getTrustedDeviceToken()).toBe('env-token')

    setTrustedDeviceGate(false)
    expect(getTrustedDeviceToken()).toBeUndefined()
  })

  it('removes only the stored trusted-device token when clearing login state', async () => {
    await writeCredentials({
      trustedDeviceToken: 'old-device-token',
      claudeAiOauth: {
        accessToken: 'oauth-access',
        refreshToken: 'oauth-refresh',
        expiresAt: '2030-01-01T00:00:00.000Z',
        scopes: ['user:profile'],
        subscriptionType: null,
        rateLimitTier: null,
      },
    })

    clearTrustedDeviceToken()

    expect(await readCredentials()).toEqual({
      claudeAiOauth: {
        accessToken: 'oauth-access',
        refreshToken: 'oauth-refresh',
        expiresAt: '2030-01-01T00:00:00.000Z',
        scopes: ['user:profile'],
        subscriptionType: null,
        rateLimitTier: null,
      },
    })
    expect(getTrustedDeviceToken()).toBeUndefined()
  })

  it('enrolls with the oauth token and persists the fresh trusted-device token', async () => {
    await writeCredentials({
      trustedDeviceToken: 'stale-device-token',
      claudeAiOauth: {
        accessToken: 'oauth-access',
        refreshToken: 'oauth-refresh',
        expiresAt: '2030-01-01T00:00:00.000Z',
        scopes: ['user:profile'],
        subscriptionType: null,
        rateLimitTier: null,
      },
    })

    expect(getTrustedDeviceToken()).toBe('stale-device-token')

    const requests: Array<{
      url: string
      authorization: string | undefined
      contentType: string | undefined
    }> = []

    axios.post = (async (url: string, _body: unknown, options?: { headers?: Record<string, string> }) => {
      requests.push({
        url,
        authorization: options?.headers?.Authorization,
        contentType: options?.headers?.['Content-Type'],
      })
      return {
        status: 201,
        data: {
          device_token: 'fresh-device-token',
          device_id: 'device-123',
        },
      } as never
    }) as typeof axios.post

    await enrollTrustedDevice()

    expect(requests).toEqual([
      {
        url: 'https://platform.example/api/auth/trusted_devices',
        authorization: 'Bearer oauth-access',
        contentType: 'application/json',
      },
    ])
    expect(await readCredentials()).toEqual({
      trustedDeviceToken: 'fresh-device-token',
      claudeAiOauth: {
        accessToken: 'oauth-access',
        refreshToken: 'oauth-refresh',
        expiresAt: '2030-01-01T00:00:00.000Z',
        scopes: ['user:profile'],
        subscriptionType: null,
        rateLimitTier: null,
      },
    })
    expect(getTrustedDeviceToken()).toBe('fresh-device-token')
  })

  it('still enrolls from the stored managed session when a static BYOK env key is present', async () => {
    process.env.ANTHROPIC_API_KEY = 'byok-static-key'
    await writeCredentials({
      claudeAiOauth: {
        accessToken: 'oauth-access',
        refreshToken: 'oauth-refresh',
        expiresAt: '2030-01-01T00:00:00.000Z',
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: null,
        rateLimitTier: null,
      },
    })

    const requests: Array<string | undefined> = []

    axios.post = (async (_url: string, _body: unknown, options?: { headers?: Record<string, string> }) => {
      requests.push(options?.headers?.Authorization)
      return {
        status: 201,
        data: {
          device_token: 'fresh-device-token',
          device_id: 'device-123',
        },
      } as never
    }) as typeof axios.post

    await enrollTrustedDevice()

    expect(requests).toEqual(['Bearer oauth-access'])
  })
})
