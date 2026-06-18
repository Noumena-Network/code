import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  getFirstPartyBaseUrlOverride,
  getNoumenaBaseUrl,
  isFirstPartyNoumenaBaseUrl,
} from './providers.js'

function resetEnv() {
  delete process.env.NOUMENA_BASE_URL
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.USER_TYPE
}

beforeEach(resetEnv)
afterEach(resetEnv)

describe('providers', () => {
  it('returns the Noumena base URL override', () => {
    process.env.NOUMENA_BASE_URL = 'https://api.noumena.com'

    expect(getNoumenaBaseUrl()).toBe('https://api.noumena.com')
    expect(getFirstPartyBaseUrlOverride()).toBe('https://api.noumena.com')
  })

  it('treats no override as first-party', () => {
    expect(getFirstPartyBaseUrlOverride()).toBeUndefined()
    expect(isFirstPartyNoumenaBaseUrl()).toBe(true)
  })

  it('accepts official Noumena hosts as first-party', () => {
    process.env.NOUMENA_BASE_URL = 'https://api.noumena.com'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(true)
  })

  it('rejects non-Noumena overrides', () => {
    process.env.NOUMENA_BASE_URL = 'http://127.0.0.1:18000'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(false)

    process.env.NOUMENA_BASE_URL = 'http://internal-gateway.invalid'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(false)

    process.env.NOUMENA_BASE_URL = 'https://code.dev.noumena.test'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(false)

    process.env.NOUMENA_BASE_URL =
      'https://internal-override.invalid'
    expect(isFirstPartyNoumenaBaseUrl()).toBe(false)
  })
})
