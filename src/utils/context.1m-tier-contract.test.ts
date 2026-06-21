import { describe, expect, test } from 'bun:test'
import { getContextWindowForModel } from './context.js'
import {
  DEEPSEEK_V4_FLASH_MODEL,
  GLM_5_2_MODEL,
  KIMI_2_7_CODER_MODEL,
} from './model/ncodeModels.js'

describe('managed [1m] tier-tag contract (P0 #4)', () => {
  // Regression: a `[1m]` tag attached to a managed model that does NOT
  // support 1M (Kimi today) must NOT inflate the reported context window.
  // Previously getContextWindowForModel checked has1mContext before the
  // managed profile lookup, silently returning 1M for Kimi[1m].
  test('Kimi model ID + [1m] tag does not inflate beyond 200K', () => {
    expect(getContextWindowForModel(KIMI_2_7_CODER_MODEL)).toBe(200_000)
    expect(getContextWindowForModel(`${KIMI_2_7_CODER_MODEL}[1m]`)).toBe(200_000)
  })

  test('GLM model ID + [1m] tag stays at 1M (natively 1M, tag is redundant)', () => {
    expect(getContextWindowForModel(GLM_5_2_MODEL)).toBe(1_000_000)
    expect(getContextWindowForModel(`${GLM_5_2_MODEL}[1m]`)).toBe(1_000_000)
  })

  test('DSV4 model ID + [1m] tag stays at 1M (natively 1M, tag is redundant)', () => {
    expect(getContextWindowForModel(DEEPSEEK_V4_FLASH_MODEL)).toBe(1_000_000)
    expect(getContextWindowForModel(`${DEEPSEEK_V4_FLASH_MODEL}[1m]`)).toBe(1_000_000)
  })

  test('managed aliases via alias strings resolve through profile lookup first', () => {
    expect(getContextWindowForModel('glm-5.2')).toBe(1_000_000)
    expect(getContextWindowForModel('glm52')).toBe(1_000_000)
    expect(getContextWindowForModel('kimi-2.7-coder')).toBe(200_000)
    expect(getContextWindowForModel('deepseek-v4-flash')).toBe(1_000_000)
    expect(getContextWindowForModel('dsv4-flash')).toBe(1_000_000)
  })
})
