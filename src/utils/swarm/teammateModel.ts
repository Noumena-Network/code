import { KIMI_2_7_CODER_MODEL } from '../model/ncodeModels.js'

// Noumena teammate sessions always use the managed Kimi model.
export function getHardcodedTeammateModelFallback(): string {
  return KIMI_2_7_CODER_MODEL
}
