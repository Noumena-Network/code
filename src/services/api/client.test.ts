import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetStateForTests } from 'src/bootstrap/state.js'
import { getClaudeAIOAuthTokens } from 'src/utils/auth.js'
import {
  CLIENT_REQUEST_ID_HEADER,
  getAnthropicClient,
  getFirstPartyRequestHeaders,
  getWrappedClientFetch,
} from './client.js'

const envKeys = [
  'NODE_ENV',
  'CI',
  'USER_TYPE',
  'CLAUDE_CODE_ENTRYPOINT',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_CONTAINER_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'NCODE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_CODE_ADDITIONAL_PROTECTION',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'NOUMENA_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'NOUMENA_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

const originalMacro = (globalThis as { MACRO?: unknown }).MACRO

function restoreEnv() {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  resetStateForTests()
  getClaudeAIOAuthTokens.cache?.clear?.()
}

function setStableTestRuntime() {
  restoreEnv()
  process.env.NODE_ENV = 'test'
  delete process.env.CI
  process.env.USER_TYPE = 'test'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.NOUMENA_API_KEY = 'baseline-api-key'
  delete process.env.NOUMENA_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  delete process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR

  ;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = {
    ...(typeof originalMacro === 'object' && originalMacro !== null
      ? (originalMacro as Record<string, unknown>)
      : {}),
    VERSION: 'test-version',
  }
}

beforeEach(() => {
  setStableTestRuntime()
})

afterEach(() => {
  restoreEnv()
  ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
})

describe('getFirstPartyRequestHeaders', () => {
  it('includes the canonical API-key header by default for direct API key sessions', async () => {
    const headers = await getFirstPartyRequestHeaders()

    expect(headers).toMatchObject({
      'x-app': 'cli',
      'x-api-key': 'baseline-api-key',
    })
    expect(headers.Authorization).toBeUndefined()
  })

  it('builds the first-party header set from auth, env metadata, and explicit api-key options', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-auth-token'
    process.env.ANTHROPIC_CUSTOM_HEADERS =
      'X-Test-One: one\nMalformedHeader\nX-Test-Two: two'
    process.env.CLAUDE_CODE_CONTAINER_ID = 'container-1'
    process.env.CLAUDE_CODE_REMOTE_SESSION_ID = 'remote-1'
    process.env.NCODE_AGENT_SDK_CLIENT_APP = 'sdk-app/1.0'
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION = '1'
    process.env.CLAUDE_CODE_ORGANIZATION_UUID = 'org-123'

    const headers = await getFirstPartyRequestHeaders({
      apiKey: 'direct-api-key',
      includeApiKeyHeader: true,
    })

    expect(headers).toMatchObject({
      'x-app': 'cli',
      Authorization: 'Bearer test-auth-token',
      'x-api-key': 'direct-api-key',
      'x-claude-remote-container-id': 'container-1',
      'x-claude-remote-session-id': 'remote-1',
      'x-client-app': 'sdk-app/1.0',
      'x-organization-uuid': 'org-123',
      'x-anthropic-additional-protection': 'true',
      'anthropic-beta': 'oauth-2025-04-20',
      'X-Test-One': 'one',
      'X-Test-Two': 'two',
    })
    expect(headers['User-Agent']).toContain('ncode/test-version')
    expect(headers['X-Claude-Code-Session-Id']).toBeTruthy()
    expect(headers['MalformedHeader']).toBeUndefined()
  })

  it('preserves managed OAuth auth tokens on first-party requests', async () => {
    delete process.env.NOUMENA_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'managed-oauth-token'

    const headers = await getFirstPartyRequestHeaders({
      includeApiKeyHeader: true,
    })

    expect(headers.Authorization).toBe('Bearer managed-oauth-token')
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(headers['x-api-key']).toBeUndefined()
  })
})

describe('getAnthropicClient canonical auth config', () => {
  it('uses the canonical auth token for managed bearer sessions', async () => {
    delete process.env.NOUMENA_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'managed-oauth-token'

    const client = await getAnthropicClient({
      maxRetries: 1,
      source: 'unit-test',
    })

    expect(client.apiKey).toBeNull()
    expect(client.authToken).toBe('managed-oauth-token')
  })

  it('keeps static BYOK env-key support on the direct Anthropic SDK path', async () => {
    delete process.env.NOUMENA_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'byok-static-env-key'

    const client = await getAnthropicClient({
      maxRetries: 1,
      source: 'unit-test',
    })

    expect(client.apiKey).toBe('byok-static-env-key')
    expect(client.authToken).toBeNull()
  })

  it('lets an explicit apiKey override win for non-bearer sessions', async () => {
    delete process.env.NOUMENA_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'byok-static-env-key'

    const client = await getAnthropicClient({
      apiKey: 'direct-override-key',
      maxRetries: 1,
      source: 'unit-test',
    })

    expect(client.apiKey).toBe('direct-override-key')
    expect(client.authToken).toBeNull()
  })
})

describe('getWrappedClientFetch', () => {
  it('injects a client request id for first-party request paths and preserves caller headers', async () => {
    let capturedHeaders: Headers | null = null
    const wrappedFetch = getWrappedClientFetch(
      async (_input, init) => {
        capturedHeaders = new Headers(init?.headers)
        return new Response('ok')
      },
      'unit-test',
    )

    await wrappedFetch('https://api.noumena.test/v1/messages', {
      method: 'POST',
      headers: {
        'x-extra-header': 'extra',
      },
    })

    expect(capturedHeaders).toBeTruthy()
    expect(capturedHeaders?.get('x-extra-header')).toBe('extra')
    expect(capturedHeaders?.get(CLIENT_REQUEST_ID_HEADER)).toBeTruthy()
  })

  it('preserves a caller-provided client request id', async () => {
    let capturedHeaders: Headers | null = null
    const wrappedFetch = getWrappedClientFetch(
      async (_input, init) => {
        capturedHeaders = new Headers(init?.headers)
        return new Response('ok')
      },
      'unit-test',
    )

    await wrappedFetch('https://api.noumena.test/v1/messages', {
      headers: {
        [CLIENT_REQUEST_ID_HEADER]: 'caller-id',
      },
    })

    expect(capturedHeaders?.get(CLIENT_REQUEST_ID_HEADER)).toBe('caller-id')
  })

  it('omits the client request id when the configured first-party host is external', async () => {
    process.env.NOUMENA_BASE_URL = 'https://gateway.example.test'

    let capturedHeaders: Headers | null = null
    const wrappedFetch = getWrappedClientFetch(
      async (_input, init) => {
        capturedHeaders = new Headers(init?.headers)
        return new Response('ok')
      },
      'unit-test',
    )

    await wrappedFetch('https://gateway.example.test/v1/messages', {})

    expect(capturedHeaders?.has(CLIENT_REQUEST_ID_HEADER)).toBe(false)
  })
})
