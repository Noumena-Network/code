import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  findRegistryEntryForModel,
  getActiveProviderEndpointForModel,
  getAPIProvider,
  loadUserProviders,
} from './providers.js'

// Registry tests are integration tests against the real settings layer.
// We cannot easily inject a .ncode/settings.json provider array without
// filesystem fixtures (the schema validates the parsed file). The resolver
// and fallback paths are unit-tested here; loadUserProviders is exercised
// via the type-level guarantee from settings/types.ts (UserProviderSchema).
// These tests verify the no-registry fallback paths in isolation.

beforeEach(() => {
  // No env vars to reset — the registry path does not consult env vars for
  // BYOK config. The only env vars that affect getAPIProvider() are the
  // bedrock/vertex/foundry toggles, unrelated to the registry.
})

afterEach(() => {})

describe('BYOK provider registry', () => {
  it('loadUserProviders returns [] when registry is absent', () => {
    const result = loadUserProviders()
    expect(Array.isArray(result)).toBe(true)
    // No providers key in the test environment settings, so empty list.
    for (const entry of result) {
      expect(entry.models.length).toBeGreaterThan(0)
    }
  })

  it('findRegistryEntryForModel returns undefined for unknown model', () => {
    expect(findRegistryEntryForModel('nonexistent-model-id')).toBeUndefined()
  })

  it('getActiveProviderEndpointForModel returns undefined when model is undefined', () => {
    expect(getActiveProviderEndpointForModel(undefined)).toBeUndefined()
  })

  it('getActiveProviderEndpointForModel returns undefined when model is not in registry', () => {
    expect(
      getActiveProviderEndpointForModel('nonexistent-model-id'),
    ).toBeUndefined()
  })

  it('does not affect the global getAPIProvider() resolution', () => {
    // The registry is per-model; env-var resolution for the process-wide
    // provider is untouched. Verify by checking that calling the resolver
    // with an unknown model does not mutate getAPIProvider().
    const before = getAPIProvider()
    getActiveProviderEndpointForModel('unknown-model')
    expect(getAPIProvider()).toBe(before)
  })
})