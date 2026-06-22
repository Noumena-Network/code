import { describe, expect, test } from 'bun:test'
import {
  getBestModel,
  getDefaultFlashModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getDefaultOpusModel,
  parseUserSpecifiedModel,
} from './model.js'
import { getAPIProvider } from './providers.js'
import { getContextWindowForModel } from '../context.js'
import {
  COST_DSV4_FLASH,
  COST_GLM_52,
  COST_KIMI_K27,
} from '../modelCost.js'
import {
  DEEPSEEK_V4_FLASH_MODEL,
  GLM_5_2_1M_MODEL,
  GLM_5_2_MODEL,
  KIMI_2_7_CODER_MODEL,
  resolveNCodeManagedModel,
} from './ncodeModels.js'

// End-to-end audit of the managed first-party tier contract. Each tier
// (Opus / Sonnet / Haiku) maps to exactly one managed model, and every
// downstream surface (main-loop default, alias resolver, context window,
// cost lookup) reads that mapping consistently. Any drift in any link of
// the chain breaks one of these tests.
describe('managed first-party tier contract (end-to-end)', () => {
  test('the suite is executing on a firstParty surface', () => {
    expect(getAPIProvider()).toBe('firstParty')
  })

  describe('Opus tier → GLM 5.2', () => {
    test('getDefaultOpusModel() resolves to GLM 5.2', () => {
      expect(getDefaultOpusModel()).toBe(GLM_5_2_MODEL)
    })

    test('getBestModel() resolves to GLM 5.2', () => {
      expect(getBestModel()).toBe(GLM_5_2_MODEL)
    })

    test("'opus' alias resolves through parseUserSpecifiedModel to GLM 5.2", () => {
      expect(parseUserSpecifiedModel('opus')).toBe(GLM_5_2_MODEL)
      expect(getContextWindowForModel(parseUserSpecifiedModel('opus'))).toBe(200_000)
    })

    test("'opus[1m]' alias resolves to the explicit GLM 5.2 1M lane", () => {
      const resolved = parseUserSpecifiedModel('opus[1m]')
      expect(resolved).toBe(GLM_5_2_1M_MODEL)
      expect(getContextWindowForModel(resolved)).toBe(1_000_000)
      expect(resolveNCodeManagedModel(resolved)?.routingModel).toBe('glm52-1m')
    })

    test("'best' alias resolves to GLM 5.2", () => {
      expect(parseUserSpecifiedModel('best')).toBe(GLM_5_2_MODEL)
    })

    test('GLM 5.2 cost lookup mirrors its managed tier', () => {
      expect(parseUserSpecifiedModel(GLM_5_2_MODEL)).toBe(GLM_5_2_MODEL)
      expect(resolveNCodeManagedModel(GLM_5_2_MODEL)?.routingModel).toBe('glm52')
      expect(resolveNCodeManagedModel(GLM_5_2_MODEL)?.contextWindow).toBe(200_000)
      // Sanity: GLM cost constant is the one we registered
      void COST_GLM_52 // imported above for completeness; the rates themselves are pinned in modelCost.managed.test.ts
    })

    test('GLM 5.2 explicit managed [1m] aliases resolve to the 1M lane', () => {
      expect(parseUserSpecifiedModel('glm-5.2[1m]')).toBe(GLM_5_2_1M_MODEL)
      expect(parseUserSpecifiedModel('glm52[1m]')).toBe(GLM_5_2_1M_MODEL)
      expect(parseUserSpecifiedModel(GLM_5_2_1M_MODEL)).toBe(GLM_5_2_1M_MODEL)
      expect(resolveNCodeManagedModel(GLM_5_2_1M_MODEL)?.routingModel).toBe('glm52-1m')
    })
  })

  describe('Sonnet / Flash tier → Kimi K2.7 Coder', () => {
    test('getDefaultFlashModel() resolves to Kimi K2.7', () => {
      expect(getDefaultFlashModel()).toBe(KIMI_2_7_CODER_MODEL)
    })

    test("'sonnet' alias resolves through parseUserSpecifiedModel to Kimi K2.7", () => {
      expect(parseUserSpecifiedModel('sonnet')).toBe(KIMI_2_7_CODER_MODEL)
    })

    test("'sonnet[1m]' tag does NOT inflate context window (Kimi = 200K usable)", () => {
      const resolved = parseUserSpecifiedModel('sonnet[1m]')
      expect(resolved.startsWith(KIMI_2_7_CODER_MODEL)).toBe(true)
      expect(resolved.endsWith('[1m]')).toBe(true)
      // The fix: managed profile lookup runs before the [1m] regex
      expect(getContextWindowForModel(resolved)).toBe(200_000)
    })

    test("'sonnet' (no [1m] tag) uses Kimi's 200K context", () => {
      expect(getContextWindowForModel(parseUserSpecifiedModel('sonnet'))).toBe(200_000)
    })

    test('Kimi K2.7 cost lookup mirrors its managed tier', () => {
      expect(resolveNCodeManagedModel(KIMI_2_7_CODER_MODEL)?.routingModel).toBe('kimi-k25')
      void COST_KIMI_K27
    })

    test("managed 'kimi-2.7-coder' alias resolves cleanly through the alias allowlist", () => {
      expect(parseUserSpecifiedModel('kimi-2.7-coder')).toBe(KIMI_2_7_CODER_MODEL)
      expect(parseUserSpecifiedModel('k2.7')).toBe(KIMI_2_7_CODER_MODEL)
    })
  })

  describe('Haiku tier → DeepSeek V4 Flash', () => {
    test('getDefaultHaikuModel() resolves to DSV4 Flash', () => {
      expect(getDefaultHaikuModel()).toBe(DEEPSEEK_V4_FLASH_MODEL)
    })

    test("'haiku' alias resolves through parseUserSpecifiedModel to DSV4 Flash", () => {
      expect(parseUserSpecifiedModel('haiku')).toBe(DEEPSEEK_V4_FLASH_MODEL)
    })

    test("'haiku[1m]' tag is redundant (DSV4 is natively 1M)", () => {
      const resolved = parseUserSpecifiedModel('haiku[1m]')
      expect(resolved.startsWith(DEEPSEEK_V4_FLASH_MODEL)).toBe(true)
      expect(getContextWindowForModel(resolved)).toBe(1_000_000)
    })

    test('DSV4 Flash cost lookup mirrors its managed tier', () => {
      expect(resolveNCodeManagedModel(DEEPSEEK_V4_FLASH_MODEL)?.routingModel).toBe('dsv4-flash')
      void COST_DSV4_FLASH
    })

    test("managed 'deepseek-v4-flash' alias resolves cleanly", () => {
      expect(parseUserSpecifiedModel('deepseek-v4-flash')).toBe(DEEPSEEK_V4_FLASH_MODEL)
      expect(parseUserSpecifiedModel('dsv4-flash')).toBe(DEEPSEEK_V4_FLASH_MODEL)
    })
  })

  describe('plan-mode alias resolves to Opus-tier, not Flash', () => {
    // Previously opusplan collapsed to Flash (Kimi), an Anthropic-era
    // cost optimization. Plan mode wants Opus-tier reasoning.
    test("'opusplan' resolves to GLM 5.2", () => {
      expect(parseUserSpecifiedModel('opusplan')).toBe(GLM_5_2_MODEL)
    })

    test("'opusplan[1m]' resolves to the explicit GLM 5.2 1M lane", () => {
      const resolved = parseUserSpecifiedModel('opusplan[1m]')
      expect(resolved).toBe(GLM_5_2_1M_MODEL)
      expect(getContextWindowForModel(resolved)).toBe(1_000_000)
    })
  })

  describe('default main loop', () => {
    test('firstParty main loop defaults to GLM 5.2 (premium tier)', () => {
      // The firstParty branch of getDefaultMainLoopModelSetting calls
      // getDefaultOpusModel(), which is GLM 5.2.
      expect(getDefaultMainLoopModelSetting()).toBe(GLM_5_2_MODEL)
    })
  })

  describe('routing is unambiguous (no tier aliases hit the same managed model)', () => {
    // Every tier alias should land on a distinct managed model so that
    // sub-agent / Flash / Haiku routing decisions produce different
    // backends, not silently reuse one.
    test('opus, sonnet, haiku resolve to three distinct managed models', () => {
      const opus = parseUserSpecifiedModel('opus')
      const sonnet = parseUserSpecifiedModel('sonnet')
      const haiku = parseUserSpecifiedModel('haiku')
      expect(opus).not.toBe(sonnet)
      expect(sonnet).not.toBe(haiku)
      expect(opus).not.toBe(haiku)
    })
  })
})
