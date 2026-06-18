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
  canUseOverageCreditGrantForSession,
  formatGrantAmount,
  getCachedOverageCreditGrant,
  invalidateOverageCreditGrantCache,
  refreshOverageCreditGrantCache,
  type OverageCreditGrantInfo,
} from './overageCreditGrant.js'

let tempConfigDir = ''
let platformBaseUrl = ''
let platformServer: null | Server = null
let grantResponse: OverageCreditGrantInfo = {
  available: true,
  eligible: true,
  granted: false,
  amount_minor_units: 2500,
  currency: 'USD',
}
const grantCalls: Array<{
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
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
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
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
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

function makeGrantSession(overrides: Record<string, unknown> = {}) {
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

function recordGrantCall(req: IncomingMessage): void {
  const requestUrl = new URL(req.url ?? '/', platformBaseUrl)
  grantCalls.push({
    url: `${requestUrl.origin}${requestUrl.pathname}${requestUrl.search}`,
    headers: {
      Authorization: req.headers.authorization ?? null,
      'Content-Type': req.headers['content-type'] ?? null,
      'anthropic-version': req.headers['anthropic-version'] ?? null,
    },
  })
}

beforeAll(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-overage-grant-'))

  platformServer = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', platformBaseUrl || 'http://127.0.0.1')
    if (
      requestUrl.pathname !==
      '/api/oauth/organizations/org-123/overage_credit_grant'
    ) {
      res.statusCode = 404
      res.end('not found')
      return
    }

    recordGrantCall(req)
    sendJson(res, grantResponse)
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
    throw new Error('Failed to bind overage credit grant test server')
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
  grantCalls.length = 0
  grantResponse = {
    available: true,
    eligible: true,
    granted: false,
    amount_minor_units: 2500,
    currency: 'USD',
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

describe('overage credit grant canonical auth gating', () => {
  it('requires a usable managed session with profile scope and an organization', () => {
    expect(canUseOverageCreditGrantForSession(makeGrantSession())).toBe(true)
    expect(
      canUseOverageCreditGrantForSession(
        makeGrantSession({
          principalSource: 'direct_api_key_env',
        }),
      ),
    ).toBe(false)
    expect(
      canUseOverageCreditGrantForSession(
        makeGrantSession({
          sessionState: 'expired',
        }),
      ),
    ).toBe(false)
    expect(
      canUseOverageCreditGrantForSession(
        makeGrantSession({
          scopes: ['user:inference'],
        }),
      ),
    ).toBe(false)
    expect(
      canUseOverageCreditGrantForSession(
        makeGrantSession({
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

    await refreshOverageCreditGrantCache()

    expect(getCachedOverageCreditGrant()).toBeNull()
    expect(grantCalls).toEqual([])
  })

  it('fetches, caches, and invalidates the grant for a usable managed session', async () => {
    seedManagedSession()

    await refreshOverageCreditGrantCache()

    expect(
      grantCalls.some(
        call =>
          call.url ===
          `${platformBaseUrl}/api/oauth/organizations/org-123/overage_credit_grant`,
      ),
    ).toBe(true)
    expect(getCachedOverageCreditGrant()).toEqual(grantResponse)
    expect(formatGrantAmount(grantResponse)).toBe('$25')

    invalidateOverageCreditGrantCache()

    expect(getCachedOverageCreditGrant()).toBeNull()
  })
})
