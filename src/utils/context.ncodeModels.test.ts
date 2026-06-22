import { describe, expect, test } from 'bun:test'
import { getContextWindowForModel, getModelMaxOutputTokens } from './context.js'
import {
  DEEPSEEK_V4_FLASH_MAX_PROMPT_TOKENS,
  DEEPSEEK_V4_FLASH_MODEL,
  GLM_5_2_1M_MAX_PROMPT_TOKENS,
  GLM_5_2_1M_MODEL,
  GLM_5_2_MAX_PROMPT_TOKENS,
  GLM_5_2_MODEL,
  KIMI_2_7_CODER_MODEL,
  NCODE_MANAGED_MODEL_MAX_PROMPT_TOKENS,
  NCODE_MANAGED_MODEL_MAX_SEQUENCE_TOKENS,
  NCODE_MANAGED_MODEL_MAX_TOKENS,
} from './model/ncodeModels.js'

describe('NCode managed model token contracts', () => {
  test.each([
    ['k2.7 alias', 'k2.7'],
    ['k2.7 model', KIMI_2_7_CODER_MODEL],
  ])('%s uses the managed prompt and sequence token contract', (_label, model) => {
    expect(getContextWindowForModel(model)).toBe(
      NCODE_MANAGED_MODEL_MAX_PROMPT_TOKENS,
    )
    expect(NCODE_MANAGED_MODEL_MAX_SEQUENCE_TOKENS).toBe(256_000)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: NCODE_MANAGED_MODEL_MAX_TOKENS,
      upperLimit: NCODE_MANAGED_MODEL_MAX_TOKENS,
    })
  })

  test.each([
    ['glm alias', 'glm-5.2'],
    ['glm compact alias', 'glm52'],
    ['glm model', GLM_5_2_MODEL],
  ])('%s uses the default GLM 5.2 managed prompt and sequence token contract', (_label, model) => {
    expect(getContextWindowForModel(model)).toBe(GLM_5_2_MAX_PROMPT_TOKENS)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: NCODE_MANAGED_MODEL_MAX_TOKENS,
      upperLimit: NCODE_MANAGED_MODEL_MAX_TOKENS,
    })
  })

  test.each([
    ['glm explicit 1m alias', 'glm-5.2[1m]'],
    ['glm compact explicit 1m alias', 'glm52[1m]'],
    ['glm explicit 1m model', GLM_5_2_1M_MODEL],
  ])('%s uses the explicit GLM 5.2 1M prompt budget', (_label, model) => {
    expect(getContextWindowForModel(model)).toBe(GLM_5_2_1M_MAX_PROMPT_TOKENS)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: NCODE_MANAGED_MODEL_MAX_TOKENS,
      upperLimit: NCODE_MANAGED_MODEL_MAX_TOKENS,
    })
  })

  test.each([
    ['dsv4 flash alias', 'deepseek-v4-flash'],
    ['dsv4 flash compact alias', 'dsv4-flash'],
    ['dsv4 flash model', DEEPSEEK_V4_FLASH_MODEL],
  ])('%s uses the DeepSeek V4 Flash 1M prompt budget', (_label, model) => {
    expect(getContextWindowForModel(model)).toBe(
      DEEPSEEK_V4_FLASH_MAX_PROMPT_TOKENS,
    )
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: NCODE_MANAGED_MODEL_MAX_TOKENS,
      upperLimit: NCODE_MANAGED_MODEL_MAX_TOKENS,
    })
  })
})
