import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getInferenceClient } from './inferenceClient.js'
import { OpenAICompatInferenceClient } from './openAICompatInferenceClient.js'
import { enableConfigs } from '../../utils/config.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import {
  KIMI_2_7_CODER_BASE_URL,
  KIMI_2_7_CODER_MODEL,
} from '../../utils/model/ncodeModels.js'

type FetchOverride = NonNullable<
  Parameters<typeof getInferenceClient>[0]['fetchOverride']
>

const envKeys = [
  'NOUMENA_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_API_KEY',
  'NOUMENA_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NCODE_CONFIG_DIR',
  'NODE_ENV',
  'CI',
  'CLAUDE_CODE_ENTRYPOINT',
  'USER_TYPE',
  'NCODE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_CODE_ORGANIZATION_UUID',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

const originalMacro = (globalThis as { MACRO?: unknown }).MACRO
let tempConfigDir = ''

function resetEnv() {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function setStableTestRuntime() {
  delete process.env.NOUMENA_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.NOUMENA_API_KEY
  delete process.env.CI

  process.env.ANTHROPIC_API_KEY = 'anthropic-direct-test-key'
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-auth-token'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  process.env.NODE_ENV = 'development'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  process.env.USER_TYPE = 'test'

  ;(globalThis as { MACRO?: Record<string, unknown> }).MACRO = {
    ...(typeof originalMacro === 'object' && originalMacro !== null
      ? (originalMacro as Record<string, unknown>)
      : {}),
    VERSION: 'test-version',
  }
}

function createModelsFetchRecorder() {
  let request:
    | {
        url: string
        method: string | undefined
        headers: Headers
      }
    | undefined

  const fetchOverride: FetchOverride = async (input, init) => {
    request = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
    }
    return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return {
    fetchOverride,
    getRequest() {
      expect(request).toBeDefined()
      return request as NonNullable<typeof request>
    },
  }
}

async function collectModels(client: OpenAICompatInferenceClient) {
  const models: Array<Record<string, unknown>> = []
  for await (const model of client.listModels()) {
    models.push(model as Record<string, unknown>)
  }
  return models
}

beforeEach(async () => {
  setStableTestRuntime()
  getClaudeAIOAuthTokens.cache?.clear?.()
  tempConfigDir = await mkdtemp(join(tmpdir(), 'inference-client-test-'))
  process.env.NCODE_CONFIG_DIR = tempConfigDir
  enableConfigs()
})

afterEach(async () => {
  resetEnv()
  getClaudeAIOAuthTokens.cache?.clear?.()
  ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = ''
  }
})

describe('getInferenceClient', () => {
  it('uses the Anthropic-backed seam when no Noumena override is configured', async () => {
    const client = await getInferenceClient({ maxRetries: 2, source: 'test' })

    expect(client).not.toBeInstanceOf(OpenAICompatInferenceClient)
    expect(client).toMatchObject({
      createMessage: expect.any(Function),
      countTokens: expect.any(Function),
      listModels: expect.any(Function),
    })
  })

  it('prefers NOUMENA_BASE_URL for the real Noumena inference path', async () => {
    process.env.NOUMENA_BASE_URL = 'http://noumena-gateway.test'
    process.env.CLAUDE_CODE_ORGANIZATION_UUID = 'org-123'
    const recorder = createModelsFetchRecorder()

    const client = await getInferenceClient({
      maxRetries: 3,
      source: 'noumena',
      apiKey: 'direct-api-key',
      fetchOverride: recorder.fetchOverride,
    })

    expect(client).toBeInstanceOf(OpenAICompatInferenceClient)
    expect(await collectModels(client as OpenAICompatInferenceClient)).toEqual([
      { id: 'test-model' },
    ])

    const request = recorder.getRequest()
    expect(request.url).toBe('http://noumena-gateway.test/v1/models')
    expect(request.method).toBe('GET')
    expect(request.headers.get('x-app')).toBe('cli')
    expect(request.headers.get('x-api-key')).toBe('direct-api-key')
    expect(request.headers.get('authorization')).toBe('Bearer test-auth-token')
    expect(request.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(request.headers.get('x-organization-uuid')).toBe('org-123')
    expect(request.headers.get('user-agent')).toContain('ncode/test-version')
    expect(request.headers.get('x-claude-code-session-id')).toBeTruthy()
  })

  it('routes managed Kimi 2.7 Coder to the configured serving edge', async () => {
    process.env.NOUMENA_BASE_URL = 'https://wrong-default.example.test'
    const recorder = createModelsFetchRecorder()

    const client = await getInferenceClient({
      maxRetries: 3,
      source: 'k2.7',
      model: KIMI_2_7_CODER_MODEL,
      fetchOverride: recorder.fetchOverride,
    })

    expect(client).toBeInstanceOf(OpenAICompatInferenceClient)
    expect(await collectModels(client as OpenAICompatInferenceClient)).toEqual([
      { id: 'test-model' },
    ])
    expect(recorder.getRequest().url).toBe(
      `${KIMI_2_7_CODER_BASE_URL}/v1/models`,
    )
  })

  it('supports non-first-party ANTHROPIC_BASE_URL as a legacy compatibility alias', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://legacy-proxy.test'
    const recorder = createModelsFetchRecorder()

    const client = await getInferenceClient({
      maxRetries: 1,
      source: 'legacy',
      fetchOverride: recorder.fetchOverride,
    })

    expect(client).toBeInstanceOf(OpenAICompatInferenceClient)
    expect(await collectModels(client as OpenAICompatInferenceClient)).toEqual([
      { id: 'test-model' },
    ])

    const request = recorder.getRequest()
    expect(request.url).toBe('http://legacy-proxy.test/v1/models')
    expect(request.headers.get('authorization')).toBe('Bearer test-auth-token')
    expect(request.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(request.headers.get('user-agent')).toContain('ncode/test-version')
  })

  it('does not reinterpret first-party Anthropic hosts as Noumena OpenAI-compatible endpoints', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

    const client = await getInferenceClient({
      maxRetries: 1,
      source: 'anthropic',
    })

    expect(client).not.toBeInstanceOf(OpenAICompatInferenceClient)
    expect(client).toMatchObject({
      createMessage: expect.any(Function),
      countTokens: expect.any(Function),
      listModels: expect.any(Function),
    })
  })

  it('forwards managed OAuth bearer auth to the Noumena inference edge', async () => {
    process.env.NOUMENA_BASE_URL = 'https://code.staging.noumena.com'
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'managed-oauth-token'

    const recorder = createModelsFetchRecorder()

    const client = await getInferenceClient({
      maxRetries: 2,
      source: 'managed-oauth',
      fetchOverride: recorder.fetchOverride,
    })

    expect(client).toBeInstanceOf(OpenAICompatInferenceClient)
    expect(await collectModels(client as OpenAICompatInferenceClient)).toEqual([
      { id: 'test-model' },
    ])

    const request = recorder.getRequest()
    expect(request.url).toBe('https://code.staging.noumena.com/v1/models')
    expect(request.headers.get('authorization')).toBe(
      'Bearer managed-oauth-token',
    )
    expect(request.headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(request.headers.get('x-api-key')).toBeNull()
  })

  it('does not force a compat API-key header onto managed bearer sessions', async () => {
    process.env.NOUMENA_BASE_URL = 'https://code.staging.noumena.com'
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'byok-static-env-key'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'managed-oauth-token'

    const recorder = createModelsFetchRecorder()

    const client = await getInferenceClient({
      maxRetries: 2,
      source: 'managed-with-byok-fallback',
      fetchOverride: recorder.fetchOverride,
    })

    expect(client).toBeInstanceOf(OpenAICompatInferenceClient)
    expect(await collectModels(client as OpenAICompatInferenceClient)).toEqual([
      { id: 'test-model' },
    ])

    const request = recorder.getRequest()
    expect(request.url).toBe('https://code.staging.noumena.com/v1/models')
    expect(request.headers.get('authorization')).toBe(
      'Bearer managed-oauth-token',
    )
    expect(request.headers.get('x-api-key')).toBeNull()
  })

  it('keeps static BYOK env-key inference working on the Noumena OpenAI-compatible edge', async () => {
    process.env.NOUMENA_BASE_URL = 'https://code.staging.noumena.com'
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'byok-static-env-key'

    const recorder = createModelsFetchRecorder()

    const client = await getInferenceClient({
      maxRetries: 2,
      source: 'byok-static-env',
      fetchOverride: recorder.fetchOverride,
    })

    expect(client).toBeInstanceOf(OpenAICompatInferenceClient)
    expect(await collectModels(client as OpenAICompatInferenceClient)).toEqual([
      { id: 'test-model' },
    ])

    const request = recorder.getRequest()
    expect(request.url).toBe('https://code.staging.noumena.com/v1/models')
    expect(request.headers.get('authorization')).toBeNull()
    expect(request.headers.get('x-api-key')).toBe('byok-static-env-key')
  })
})
