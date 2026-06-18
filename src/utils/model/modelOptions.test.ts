import { afterEach, describe, expect, it } from 'bun:test'
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
})
