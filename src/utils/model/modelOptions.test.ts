import { afterEach, describe, expect, it } from 'bun:test'
import {
  KIMI_2_7_CODER_MODEL,
} from './ncodeModels.js'
import { parseUserSpecifiedModel } from './model.js'
import {
  getDefaultOptionForUser,
  getModelOptions,
  modelOptionsReferToSameModel,
} from './modelOptions.js'

afterEach(() => {
  delete process.env.NCODE_BUILD_MODE
  delete process.env.NOU_SUSPENDED
  delete process.env.USER_TYPE
})

describe('modelOptions', () => {
  it('always includes the default option', () => {
    const options = getModelOptions()
    expect(options[0]).toEqual(getDefaultOptionForUser())
  })

  it('includes Noumena-managed Kimi 2.7 Coder', () => {
    const options = getModelOptions()
    const labels = options.map(o => o.label)
    expect(labels).toContain('Kimi 2.7 Coder')
  })

  it('does not include third-party provider options', () => {
    const options = getModelOptions()
    const labels = options.map(o => o.label)
    expect(labels).not.toContain('Balanced')
    expect(labels).not.toContain('Reasoning')
    expect(labels).not.toContain('Fast')
  })

  it('matches aliases to the same model', () => {
    expect(modelOptionsReferToSameModel('Kimi 2.7 Coder', 'k2.7')).toBe(true)
    expect(modelOptionsReferToSameModel('kimi-2.7-coder', 'k2.7')).toBe(true)
    expect(
      modelOptionsReferToSameModel('kimi-2.7-coder', 'claude-3-opus-4-5'),
    ).toBe(false)
  })

  it('maps legacy Anthropic aliases to the managed Kimi model', () => {
    expect(parseUserSpecifiedModel('sonnet')).toBe(KIMI_2_7_CODER_MODEL)
    expect(parseUserSpecifiedModel('opus')).toBe(KIMI_2_7_CODER_MODEL)
    expect(parseUserSpecifiedModel('haiku')).toBe(KIMI_2_7_CODER_MODEL)
    expect(parseUserSpecifiedModel('opusplan')).toBe(KIMI_2_7_CODER_MODEL)
    expect(parseUserSpecifiedModel('sonnet[1m]')).toBe(
      `${KIMI_2_7_CODER_MODEL}[1m]`,
    )
  })
})
