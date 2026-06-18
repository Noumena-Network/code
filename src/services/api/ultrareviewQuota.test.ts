import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearOAuthTokenCache,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import {
  _setGlobalConfigCacheForTesting,
  enableConfigs,
  saveGlobalConfig,
} from '../../utils/config.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import {
  canFetchUltrareviewQuotaForSession,
  fetchUltrareviewQuota,
  type UltrareviewQuotaResponse,
} from './ultrareviewQuota.js'

let tempConfigDir = ''
let platformBaseUrl = ''
let platformServer: null | Server = null
let quotaResponse: UltrareviewQuotaResponse = {
  reviews_used: 1,
  reviews_limit: 5,
  reviews_remaining: 4,
  is_overage: false,
}
const quotaCalls: Array<{
  url: string
  headers: Record<string, string | null>
}> = []
const originalMacro = (globalThis as { MACRO?: unknown }).MACRO

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
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_ENTRYPOINT',
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
  process.env.NOUMENA_PLATFORM_BASE_URL = platformBaseUrl
  process.env.NOUMENA_ISSUER_BASE_URL = platformBaseUrl
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.NOUMENA_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.CLAUDE_CODE_ORGANIZATION_UUID
  delete process.env.CLAUDE_CODE_ENTRYPOINT

  ;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = {
    ...(typeof originalMacro === 'object' && originalMacro !== null
      ? (originalMacro as Record<string, unknown>)
      : {}),
    VERSION: 'test-version',
  }
}

function seedManagedSession(): void {
  saveOAuthTokensIfNeeded({
    accessToken: 'oauth-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 10 * 60_000,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'tier-1',
  })
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: {
      accountUuid: 'acct-123',
      emailAddress: 'user@example.com',
      organizationUuid: 'org-123',
      organizationName: 'Acme',
    },
  }))
}

function makeUltrareviewSession(overrides: Record<string, unknown> = {}) {
  return {
    principalSource: 'managed_oauth',
    sessionState: 'usable',
    identity: {
      email: 'user@example.com',
      accountUuid: 'acct-123',
      organizationUuid: 'org-123',
      organizationName: 'Acme',
    },
    scopes: ['user:profile', 'user:inference'],
    accessToken: 'oauth-token',
    ...overrides,
  }
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function recordQuotaCall(req: IncomingMessage): void {
  const requestUrl = new URL(req.url ?? '/', platformBaseUrl)
  quotaCalls.push({
    url: `${requestUrl.origin}${requestUrl.pathname}${requestUrl.search}`,
    headers: {
      Authorization: req.headers.authorization ?? null,
      'Content-Type': req.headers['content-type'] ?? null,
      'anthropic-version': req.headers['anthropic-version'] ?? null,
      'x-organization-uuid': req.headers['x-organization-uuid'] ?? null,
    },
  })
}

beforeAll(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-ultrareview-quota-'))

  platformServer = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', platformBaseUrl || 'http://127.0.0.1')
    if (requestUrl.pathname !== '/v1/ultrareview/quota') {
      res.statusCode = 404
      res.end('not found')
      return
    }

    recordQuotaCall(req)
    sendJson(res, quotaResponse)
  })

  await new Promise<void>((resolve, reject) => {
    platformServer?.listen(0, '127.0.0.1', err => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })

  const address = platformServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind ultrareview quota test server')
  }
  platformBaseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(() => {
  restoreEnv()
  setStableTestRuntime()
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  quotaCalls.length = 0
  quotaResponse = {
    reviews_used: 1,
    reviews_limit: 5,
    reviews_remaining: 4,
    is_overage: false,
  }
})

afterEach(() => {
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  restoreEnv()
  ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
})

afterAll(async () => {
  if (platformServer) {
    await new Promise<void>((resolve, reject) => {
      platformServer?.close(err => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }
  await rm(tempConfigDir, { recursive: true, force: true })
})

describe('ultrareview quota canonical auth gating', () => {
  it('requires a usable managed session with profile scope and an organization', () => {
    expect(canFetchUltrareviewQuotaForSession(makeUltrareviewSession())).toBe(
      true,
    )
    expect(
      canFetchUltrareviewQuotaForSession(
        makeUltrareviewSession({
          principalSource: 'direct_api_key_env',
          sessionState: 'usable',
        }),
      ),
    ).toBe(false)
    expect(
      canFetchUltrareviewQuotaForSession(
        makeUltrareviewSession({
          sessionState: 'expired',
        }),
      ),
    ).toBe(false)
    expect(
      canFetchUltrareviewQuotaForSession(
        makeUltrareviewSession({
          scopes: ['user:inference'],
        }),
      ),
    ).toBe(false)
    expect(
      canFetchUltrareviewQuotaForSession(
        makeUltrareviewSession({
          identity: {
            email: 'user@example.com',
            accountUuid: 'acct-123',
            organizationUuid: null,
            organizationName: null,
          },
        }),
      ),
    ).toBe(false)
  })

  it('fails closed before network for static BYOK env-key sessions', async () => {
    process.env.ANTHROPIC_API_KEY = 'byok-key'

    expect(await fetchUltrareviewQuota()).toBeNull()
    expect(quotaCalls).toEqual([])
  })

  it('fetches quota for a usable managed session with organization metadata', async () => {
    seedManagedSession()

    expect(await fetchUltrareviewQuota()).toEqual(quotaResponse)
    expect(
      quotaCalls.some(
        call => call.url === `${platformBaseUrl}/v1/ultrareview/quota`,
      ),
    ).toBe(true)
  })
})
