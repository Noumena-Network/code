import { describe, expect, test } from 'bun:test'
import {
  calculateUSDCost,
  COST_DSV4_FLASH,
  COST_GLM_52,
  COST_KIMI_K27,
  MODEL_COSTS,
} from './modelCost.js'
import {
  DEEPSEEK_V4_FLASH_MODEL,
  GLM_5_2_MODEL,
  KIMI_2_7_CODER_MODEL,
} from './model/ncodeModels.js'
import { getCanonicalName } from './model/model.js'

// Upstream rate cards are mirrored exactly — no markup. If any of these
// numbers drift, it should be an intentional decision tied to a
// provider-side rate change, not a silent edit. Sources are inlined in
// the comments on each cost constant.
describe('managed model pricing mirrors upstream (no markup)', () => {
  test('GLM 5.2 mirrors Z.ai published rates', () => {
    // https://docs.z.ai/guides/overview/pricing
    expect(COST_GLM_52.inputTokens).toBe(1.4)
    expect(COST_GLM_52.outputTokens).toBe(4.4)
    expect(COST_GLM_52.promptCacheReadTokens).toBe(0.26)
    // Z.ai does not publish a separate cache-write tier; cache-miss falls
    // back to the regular input rate.
    expect(COST_GLM_52.promptCacheWriteTokens).toBe(1.4)
  })

  test('Kimi K2.7 Code mirrors Moonshot published rates', () => {
    // https://platform.kimi.ai/docs/pricing/chat-k27-code
    expect(COST_KIMI_K27.inputTokens).toBe(0.95)
    expect(COST_KIMI_K27.outputTokens).toBe(4)
    expect(COST_KIMI_K27.promptCacheReadTokens).toBe(0.19)
    expect(COST_KIMI_K27.promptCacheWriteTokens).toBe(0.95)
  })

  test('DeepSeek V4 Flash mirrors DeepSeek published rates', () => {
    // https://api-docs.deepseek.com/quick_start/pricing
    expect(COST_DSV4_FLASH.inputTokens).toBe(0.14)
    expect(COST_DSV4_FLASH.outputTokens).toBe(0.28)
    expect(COST_DSV4_FLASH.promptCacheReadTokens).toBe(0.0028)
    expect(COST_DSV4_FLASH.promptCacheWriteTokens).toBe(0.14)
  })

  test('MODEL_COSTS includes managed model IDs keyed by canonical name', () => {
    expect(MODEL_COSTS[getCanonicalName(GLM_5_2_MODEL)]).toBe(COST_GLM_52)
    expect(MODEL_COSTS[getCanonicalName(KIMI_2_7_CODER_MODEL)]).toBe(COST_KIMI_K27)
    expect(MODEL_COSTS[getCanonicalName(DEEPSEEK_V4_FLASH_MODEL)]).toBe(COST_DSV4_FLASH)
  })

  test('calculateUSDCost uses managed model prices instead of fallback pricing', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }

    expect(calculateUSDCost(GLM_5_2_MODEL, usage)).toBe(
      COST_GLM_52.inputTokens + COST_GLM_52.outputTokens,
    )
    expect(calculateUSDCost(KIMI_2_7_CODER_MODEL, usage)).toBe(
      COST_KIMI_K27.inputTokens + COST_KIMI_K27.outputTokens,
    )
    expect(calculateUSDCost(DEEPSEEK_V4_FLASH_MODEL, usage)).toBe(
      COST_DSV4_FLASH.inputTokens + COST_DSV4_FLASH.outputTokens,
    )
  })
})
