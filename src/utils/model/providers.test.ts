import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  getAnthropicBaseUrl,
  getAPIProvider,
  getCustomProviderApiKey,
  getCustomProviderBaseUrl,
  getFirstPartyBaseUrlOverride,
  getNoumenaBaseUrl,
  isFirstPartyNoumenaBaseUrl,
} from './providers.js'

function resetEnv() {
  delete process.env.NOUMENA_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.USER_TYPE
  delete process.env.NCODE_USE_CUSTOM_PROVIDER
  delete process.env.NCODE_CUSTOM_PROVIDER_URL
  delete process.env.NCODE_CUSTOM_PROVIDER_API_KEY
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
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
})

describe('custom provider', () => {
  it('returns firstParty when custom provider is not enabled', () => {
    expect(getAPIProvider()).toBe('firstParty')
  })

  it('returns custom when NCODE_USE_CUSTOM_PROVIDER is set but URL and key are missing', () => {
    process.env.NCODE_USE_CUSTOM_PROVIDER = '1'
    expect(getAPIProvider()).toBe('custom')
  })

  it('returns custom when URL is set but key is missing', () => {
    process.env.NCODE_USE_CUSTOM_PROVIDER = '1'
    process.env.NCODE_CUSTOM_PROVIDER_URL = 'https://api.deepseek.com'
    expect(getAPIProvider()).toBe('custom')
  })

  it('returns custom when key is set but URL is missing', () => {
    process.env.NCODE_USE_CUSTOM_PROVIDER = '1'
    process.env.NCODE_CUSTOM_PROVIDER_API_KEY = 'sk-test'
    expect(getAPIProvider()).toBe('custom')
  })

  it('returns custom when all three env vars are set', () => {
    process.env.NCODE_USE_CUSTOM_PROVIDER = '1'
    process.env.NCODE_CUSTOM_PROVIDER_URL = 'https://api.deepseek.com'
    process.env.NCODE_CUSTOM_PROVIDER_API_KEY = 'sk-test'
    expect(getAPIProvider()).toBe('custom')
  })

  it('normalizes whitespace in URL', () => {
    process.env.NCODE_USE_CUSTOM_PROVIDER = '1'
    process.env.NCODE_CUSTOM_PROVIDER_URL = '  https://api.deepseek.com  '
    process.env.NCODE_CUSTOM_PROVIDER_API_KEY = 'sk-test'
    expect(getCustomProviderBaseUrl()).toBe('https://api.deepseek.com')
  })

  it('returns undefined for whitespace-only API key but provider still custom', () => {
    process.env.NCODE_USE_CUSTOM_PROVIDER = '1'
    process.env.NCODE_CUSTOM_PROVIDER_URL = 'https://api.deepseek.com'
    process.env.NCODE_CUSTOM_PROVIDER_API_KEY = '   '
    expect(getAPIProvider()).toBe('custom')
    expect(getCustomProviderApiKey()).toBeUndefined()
  })

  it('returns undefined for missing API key', () => {
    expect(getCustomProviderApiKey()).toBeUndefined()
  })

  it('returns undefined for missing base URL', () => {
    expect(getCustomProviderBaseUrl()).toBeUndefined()
  })

  it('returns empty key as undefined', () => {
    process.env.NCODE_CUSTOM_PROVIDER_API_KEY = ''
    expect(getCustomProviderApiKey()).toBeUndefined()
  })

  it('bedrock takes priority over custom provider', () => {
    process.env.NCODE_USE_CUSTOM_PROVIDER = '1'
    process.env.NCODE_CUSTOM_PROVIDER_URL = 'https://api.deepseek.com'
    process.env.NCODE_CUSTOM_PROVIDER_API_KEY = 'sk-test'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(getAPIProvider()).toBe('bedrock')
  })
})
