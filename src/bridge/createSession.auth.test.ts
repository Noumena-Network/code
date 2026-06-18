import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { saveGlobalConfig, enableConfigs, _setGlobalConfigCacheForTesting } from '../utils/config.js'
import { clearOAuthTokenCache } from '../utils/auth.js'
import { getSecureStorage } from '../utils/secureStorage/index.js'
import {
  archiveBridgeSession,
  createBridgeSession,
  getBridgeSession,
  updateBridgeSessionTitle,
} from './createSession.js'

const envKeys = [
  'NODE_ENV',
  'CI',
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
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

const originalAxiosPost = axios.post
const originalAxiosGet = axios.get
const originalAxiosPatch = axios.patch

let tempConfigDir = ''

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function setStableTestRuntime(): void {
  process.env.NODE_ENV = 'production'
  delete process.env.CI
  process.env.NCODE_CONFIG_DIR = tempConfigDir
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  process.env.NOUMENA_PLATFORM_BASE_URL = 'https://api.noumena.test'
  process.env.NOUMENA_ISSUER_BASE_URL = 'https://auth.noumena.test'
  delete process.env.NOUMENA_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  delete process.env.USER_TYPE
}

function saveManagedAccountMetadata(): void {
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: {
      accountUuid: 'acct-1',
      emailAddress: 'dev@noumena.com',
      organizationUuid: 'org-123',
      organizationName: 'Acme',
    },
  }))
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-bridge-create-auth-'))
  restoreEnv()
  setStableTestRuntime()
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  axios.post = originalAxiosPost
  axios.get = originalAxiosGet
  axios.patch = originalAxiosPatch
})

afterEach(async () => {
  axios.post = originalAxiosPost
  axios.get = originalAxiosGet
  axios.patch = originalAxiosPatch
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  restoreEnv()
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = ''
  }
})

describe('bridge session auth capability integration', () => {
  it('creates bridge sessions through the shared remote capability seam and preserves token overrides', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'
    saveManagedAccountMetadata()

    axios.post = (async (url, body, config) => {
      expect(url).toBe('https://api.noumena.test/v1/sessions')
      expect(body).toEqual(
        expect.objectContaining({
          title: 'Bridge title',
          environment_id: 'env-1',
          source: 'remote-control',
        }),
      )
      expect(config?.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer bridge-override-token',
          'x-organization-uuid': 'org-123',
        }),
      )
      return {
        status: 201,
        data: { id: 'session-123' },
      } as Awaited<ReturnType<typeof axios.post>>
    }) as typeof axios.post

    const sessionId = await createBridgeSession({
      environmentId: 'env-1',
      title: 'Bridge title',
      events: [],
      gitRepoUrl: null,
      branch: 'main',
      signal: new AbortController().signal,
      baseUrl: 'https://api.noumena.test',
      getAccessToken: () => 'bridge-override-token',
    })

    expect(sessionId).toBe('session-123')
  })

  it('fetches bridge sessions through the shared remote capability seam', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'
    saveManagedAccountMetadata()

    axios.get = (async (url, config) => {
      expect(url).toBe('https://api.noumena.test/v1/sessions/session-123')
      expect(config?.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer bridge-override-token',
          'x-organization-uuid': 'org-123',
        }),
      )
      return {
        status: 200,
        data: { environment_id: 'env-1', title: 'Bridge session' },
      } as Awaited<ReturnType<typeof axios.get>>
    }) as typeof axios.get

    await expect(
      getBridgeSession('session-123', {
        baseUrl: 'https://api.noumena.test',
        getAccessToken: () => 'bridge-override-token',
      }),
    ).resolves.toEqual({
      environment_id: 'env-1',
      title: 'Bridge session',
    })
  })

  it('fails closed before network when session archive cannot resolve a remote capability', async () => {
    let networkCalls = 0
    axios.post = (async () => {
      networkCalls += 1
      throw new Error('network should not be reached')
    }) as typeof axios.post

    process.env.NOUMENA_API_KEY = 'noumena-api-key'

    await archiveBridgeSession('session-123', {
      baseUrl: 'https://api.noumena.test',
    })

    expect(networkCalls).toBe(0)
  })

  it('updates bridge session titles through the shared remote capability seam and preserves compat session ids', async () => {
    process.env.NOUMENA_API_KEY = 'noumena-api-key'
    saveManagedAccountMetadata()

    axios.patch = (async (url, body, config) => {
      expect(url).toBe('https://api.noumena.test/v1/sessions/session_123')
      expect(body).toEqual({ title: 'Renamed session' })
      expect(config?.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer bridge-override-token',
          'x-organization-uuid': 'org-123',
        }),
      )
      return {
        status: 200,
        data: {},
      } as Awaited<ReturnType<typeof axios.patch>>
    }) as typeof axios.patch

    await updateBridgeSessionTitle('cse_123', 'Renamed session', {
      baseUrl: 'https://api.noumena.test',
      getAccessToken: () => 'bridge-override-token',
    })
  })
})
