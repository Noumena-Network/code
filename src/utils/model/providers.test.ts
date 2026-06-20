import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  getAnthropicBaseUrl,
  getAPIProvider,
  getFirstPartyBaseUrlOverride,
  getNoumenaBaseUrl,
  isFirstPartyNoumenaBaseUrl,
} from './providers.js'

function resetEnv() {
  delete process.env.NOUMENA_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.USER_TYPE
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

  it('returns firstParty when no provider env vars are set', () => {
    expect(getAPIProvider()).toBe('firstParty')
  })

  it('bedrock takes priority over vertex and foundry', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
    expect(getAPIProvider()).toBe('bedrock')
  })
})