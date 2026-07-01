import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  getAnthropicBaseUrl,
  getFirstPartyBaseUrlOverride,
  getNoumenaBaseUrl,
  getOpenAICompatBaseUrl,
  getOpenAICompatDefaultModel,
  isOpenAICompatByokActive,
  isFirstPartyNoumenaBaseUrl,
} from './providers.js'

function resetEnv() {
  delete process.env.NOUMENA_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL
  delete process.env.USER_TYPE
}

beforeEach(resetEnv)
afterEach(resetEnv)

describe('providers', () => {
  it('prefers NOUMENA_BASE_URL over legacy ANTHROPIC_BASE_URL', () => {
    process.env.NOUMENA_BASE_URL = 'https://api.noumena.com'
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

    expect(getNoumenaBaseUrl()).toBe('https://api.noumena.com')
    expect(getAnthropicBaseUrl()).toBe('https://api.anthropic.com')
    expect(getFirstPartyBaseUrlOverride()).toBe('https://api.noumena.com')
  })

  it('treats no override as first-party', () => {
    expect(getFirstPartyBaseUrlOverride()).toBeUndefined()
    expect(isFirstPartyNoumenaBaseUrl()).toBe(true)
  })

  it('accepts official Noumena and legacy Anthropic hosts as first-party', () => {
    process.env.NOUMENA_BASE_URL = 'https://api.noumena.com'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(true)

    delete process.env.NOUMENA_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(true)
  })

  it('rejects non-first-party overrides', () => {
    process.env.NOUMENA_BASE_URL = 'http://127.0.0.1:18000'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(false)

    process.env.NOUMENA_BASE_URL = 'http://internal-gateway.invalid'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(false)

    process.env.NOUMENA_BASE_URL = 'https://code.dev.noumena.test'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(false)

    process.env.NOUMENA_BASE_URL =
      'https://internal-override.invalid'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(false)

    delete process.env.NOUMENA_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://corp-proxy.example.com'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(false)
  })

  it('preserves Anthropic staging for ant users', () => {
    process.env.USER_TYPE = 'ant'
    process.env.ANTHROPIC_BASE_URL = 'https://api-staging.anthropic.com'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(true)
  })


  it('activates OpenAI-compatible BYOK only for OPENAI_API_KEY', () => {
    expect(isOpenAICompatByokActive()).toBe(false)
    expect(getOpenAICompatBaseUrl()).toBeUndefined()

    process.env.OPENAI_API_KEY = 'openai-key'

    expect(isOpenAICompatByokActive()).toBe(true)
    expect(getOpenAICompatBaseUrl()).toBe('https://api.openai.com')
    expect(getOpenAICompatDefaultModel()).toBe('gpt-5.1-codex')
  })

  it('uses explicit OpenAI-compatible base URL and model overrides', () => {
    process.env.OPENAI_API_KEY = 'openai-key'
    process.env.OPENAI_BASE_URL = ' https://openrouter.ai/api/v1 '
    process.env.OPENAI_MODEL = ' openrouter/custom-model '

    expect(getOpenAICompatBaseUrl()).toBe('https://openrouter.ai/api/v1')
    expect(getOpenAICompatDefaultModel()).toBe('openrouter/custom-model')
  })

})
