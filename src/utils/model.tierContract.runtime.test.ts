import { describe, expect, test } from 'bun:test'
import {
  getDefaultFlashModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getDefaultOpusModel,
  parseUserSpecifiedModel,
} from './model/model.js'
import {
  DEEPSEEK_V4_FLASH_MODEL,
  GLM_5_2_MODEL,
  KIMI_2_7_CODER_MODEL,
} from './model/ncodeModels.js'

describe('first-party tier contract (managed defaults)', () => {
  test('opus tier resolves to GLM 5.2', () => {
    expect(getDefaultOpusModel()).toBe(GLM_5_2_MODEL)
  })

  test('flash/sonnet tier resolves to Kimi K2.7 Code', () => {
    expect(getDefaultFlashModel()).toBe(KIMI_2_7_CODER_MODEL)
  })

  test('haiku tier resolves to DeepSeek V4 Flash', () => {
    expect(getDefaultHaikuModel()).toBe(DEEPSEEK_V4_FLASH_MODEL)
  })

  test('main loop defaults to the opus tier (GLM 5.2)', () => {
    expect(getDefaultMainLoopModelSetting()).toBe(GLM_5_2_MODEL)
  })

  test('tier aliases resolve through opus/sonnet/haiku', () => {
    expect(parseUserSpecifiedModel('opus')).toBe(GLM_5_2_MODEL)
    expect(parseUserSpecifiedModel('sonnet')).toBe(KIMI_2_7_CODER_MODEL)
    expect(parseUserSpecifiedModel('haiku')).toBe(DEEPSEEK_V4_FLASH_MODEL)
  })

  test('plan-mode alias resolves to the opus tier', () => {
    expect(parseUserSpecifiedModel('opusplan')).toBe(GLM_5_2_MODEL)
  })
})