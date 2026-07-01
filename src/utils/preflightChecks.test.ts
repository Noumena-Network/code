import { afterEach, describe, expect, it } from 'bun:test'
import { getPreflightEndpoints } from './preflightChecks.js'

const originalNoumenaPlatformBaseUrl = process.env.NOUMENA_PLATFORM_BASE_URL
const originalNoumenaIssuerBaseUrl = process.env.NOUMENA_ISSUER_BASE_URL

afterEach(() => {
  delete process.env.NOUMENA_PLATFORM_BASE_URL
  delete process.env.NOUMENA_ISSUER_BASE_URL

  if (originalNoumenaPlatformBaseUrl) {
    process.env.NOUMENA_PLATFORM_BASE_URL = originalNoumenaPlatformBaseUrl
  }
  if (originalNoumenaIssuerBaseUrl) {
    process.env.NOUMENA_ISSUER_BASE_URL = originalNoumenaIssuerBaseUrl
  }
})

describe('getPreflightEndpoints', () => {
  it('prefers explicit Noumena platform and issuer overrides', () => {
    process.env.NOUMENA_PLATFORM_BASE_URL = 'https://platform-api.noumena.test/'
    process.env.NOUMENA_ISSUER_BASE_URL = 'https://issuer.noumena.test/'

    // #11 changed preflight from reachability (/healthz + JWKS) to auth-flow
    // validation (/v1/me + oauth/token), so we catch auth/config failures at
    // startup rather than only server-down failures.
    expect(getPreflightEndpoints()).toEqual([
      'https://platform-api.noumena.test/v1/me',
      'https://issuer.noumena.test/oauth/token',
    ])
  })
})
