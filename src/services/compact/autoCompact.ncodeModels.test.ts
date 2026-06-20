import { describe, expect, test } from 'bun:test'
import {
  calculateTokenWarningState,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} from './autoCompact.js'
import {
  GLM_5_2_MAX_PROMPT_TOKENS,
  GLM_5_2_MODEL,
  KIMI_2_7_CODER_MODEL,
  NCODE_MANAGED_MODEL_MAX_PROMPT_TOKENS,
} from '../../utils/model/ncodeModels.js'

describe('auto compact managed model prompt budgets', () => {
  test.each([
    ['k2.7 alias', 'k2.7'],
    ['k2.7 model', KIMI_2_7_CODER_MODEL],
  ])(
    '%s treats the managed context window as an input prompt budget',
    (_label, model) => {
      expect(getEffectiveContextWindowSize(model)).toBe(
        NCODE_MANAGED_MODEL_MAX_PROMPT_TOKENS,
      )
      expect(getAutoCompactThreshold(model)).toBe(187_000)

      expect(calculateTokenWarningState(175_000, model)).toMatchObject({
        isAboveAutoCompactThreshold: false,
        isAtBlockingLimit: false,
      })
      expect(calculateTokenWarningState(198_000, model)).toMatchObject({
        isAboveAutoCompactThreshold: true,
        isAtBlockingLimit: true,
      })
    },
  )

  test.each([
    ['glm alias', 'glm-5.2'],
    ['glm compact alias', 'glm52'],
    ['glm model', GLM_5_2_MODEL],
  ])('%s uses the GLM 5.2 1M autocompact budget', (_label, model) => {
    expect(getEffectiveContextWindowSize(model)).toBe(
      GLM_5_2_MAX_PROMPT_TOKENS,
    )
    expect(getAutoCompactThreshold(model)).toBe(987_000)

    expect(calculateTokenWarningState(980_000, model)).toMatchObject({
      isAboveAutoCompactThreshold: false,
      isAtBlockingLimit: false,
    })
    expect(calculateTokenWarningState(995_000, model)).toMatchObject({
      isAboveAutoCompactThreshold: true,
      isAtBlockingLimit: false,
    })
    expect(calculateTokenWarningState(998_000, model)).toMatchObject({
      isAboveAutoCompactThreshold: true,
      isAtBlockingLimit: true,
    })
  })

  test('keeps the legacy output-summary reserve for non-managed models', () => {
    expect(getEffectiveContextWindowSize('claude-opus-4-6')).toBe(180_000)
    expect(getAutoCompactThreshold('claude-opus-4-6')).toBe(167_000)
  })
})
