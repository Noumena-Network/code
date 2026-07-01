import { describe, expect, test } from 'bun:test'
import { getContextWindowForModel } from './context.js'
import {
  DEEPSEEK_V4_FLASH_MODEL,
  GLM_5_2_1M_MODEL,
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

  // b248c43 split GLM 5.2 into a 200K base lane and an explicit `[1m]` 1M
  // lane, so the bare model ID and bare aliases resolve to the 200K managed
  // lane. Only the `[1m]`-suffixed model ID lands on the 1M lane.
  test('GLM 5.2 base lane stays at 200K; [1m] lane is 1M', () => {
    expect(getContextWindowForModel(GLM_5_2_MODEL)).toBe(200_000)
    expect(getContextWindowForModel(GLM_5_2_1M_MODEL)).toBe(1_000_000)
    expect(getContextWindowForModel(`${GLM_5_2_MODEL}[1m]`)).toBe(1_000_000)
  })

  test('DSV4 model ID + [1m] tag stays at 1M (natively 1M, tag is redundant)', () => {
    expect(getContextWindowForModel(DEEPSEEK_V4_FLASH_MODEL)).toBe(1_000_000)
    expect(getContextWindowForModel(`${DEEPSEEK_V4_FLASH_MODEL}[1m]`)).toBe(1_000_000)
  })

  test('managed aliases resolve through profile lookup (GLM base lane is 200K, [1m] aliases are 1M)', () => {
    expect(getContextWindowForModel('glm-5.2')).toBe(200_000)
    expect(getContextWindowForModel('glm52')).toBe(200_000)
    expect(getContextWindowForModel('glm-5.2[1m]')).toBe(1_000_000)
    expect(getContextWindowForModel('glm52[1m]')).toBe(1_000_000)
    expect(getContextWindowForModel('kimi-2.7-coder')).toBe(200_000)
    expect(getContextWindowForModel('deepseek-v4-flash')).toBe(1_000_000)
    expect(getContextWindowForModel('dsv4-flash')).toBe(1_000_000)
  })
})
