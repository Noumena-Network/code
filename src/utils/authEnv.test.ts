import { afterEach, describe, expect, it } from 'bun:test'
import {
  getDirectApiKeyEnvValue,
  getDirectApiKeyProviderKind,
  getDirectApiKeyProviderMode,
  getDirectApiKeyEnvVarName,
} from './authEnv.js'

const originalNoumenaApiKey = process.env.NOUMENA_API_KEY
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
const originalOpenAIApiKey = process.env.OPENAI_API_KEY

afterEach(() => {
  if (originalNoumenaApiKey === undefined) {
    delete process.env.NOUMENA_API_KEY
  } else {
    process.env.NOUMENA_API_KEY = originalNoumenaApiKey
  }

  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }

  if (originalOpenAIApiKey === undefined) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIApiKey
  }
})

describe('auth env helpers', () => {
  it('prefers NOUMENA_API_KEY when all direct key aliases are set', () => {
    process.env.NOUMENA_API_KEY = 'noumena-key'
    process.env.ANTHROPIC_API_KEY = 'anthropic-key'
    process.env.OPENAI_API_KEY = 'openai-key'

    expect(getDirectApiKeyEnvVarName()).toBe('NOUMENA_API_KEY')
    expect(getDirectApiKeyEnvValue()).toBe('noumena-key')
    expect(getDirectApiKeyProviderMode()).toBe('noumena_managed')
    expect(getDirectApiKeyProviderKind()).toBe('noumena')
  })

  it('prefers ANTHROPIC_API_KEY over OPENAI_API_KEY for backwards compatibility', () => {
    delete process.env.NOUMENA_API_KEY
    process.env.ANTHROPIC_API_KEY = 'anthropic-key'
    process.env.OPENAI_API_KEY = 'openai-key'

    expect(getDirectApiKeyEnvVarName()).toBe('ANTHROPIC_API_KEY')
    expect(getDirectApiKeyEnvValue()).toBe('anthropic-key')
    expect(getDirectApiKeyProviderMode()).toBe('byok_static_env')
    expect(getDirectApiKeyProviderKind()).toBe('anthropic')
  })

  it('falls back to OPENAI_API_KEY as OpenAI-compatible BYOK', () => {
    delete process.env.NOUMENA_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = 'openai-key'

    expect(getDirectApiKeyEnvVarName()).toBe('OPENAI_API_KEY')
    expect(getDirectApiKeyEnvValue()).toBe('openai-key')
    expect(getDirectApiKeyProviderMode()).toBe('byok_static_env')
    expect(getDirectApiKeyProviderKind()).toBe('openai_compat')
  })
})
