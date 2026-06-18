// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { getGlobalConfig } from '../config.js'
import {
  formatModelPricing,
  COST_KIMI_2_7_CODER,
} from '../modelCost.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getDefaultMainLoopModelSetting,
  getUserSpecifiedModelSetting,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import {
  getNCodeManagedModelOptions,
  resolveNCodeManagedModel,
} from './ncodeModels.js'

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function modelOptionsReferToSameModel(
  a: ModelSetting,
  b: ModelSetting,
): boolean {
  if (a === b) return true
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const aProfile = resolveNCodeManagedModel(a)
  const bProfile = resolveNCodeManagedModel(b)
  return Boolean(aProfile && bProfile && aProfile.model === bProfile.model)
}

export function getDefaultOptionForUser(_fastMode = false): ModelOption {
  const currentModel = renderDefaultModelSetting(
    getDefaultMainLoopModelSetting(),
  )
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${currentModel}) · ${formatModelPricing(COST_KIMI_2_7_CODER)}`,
    descriptionForModel: `Default model (currently ${currentModel})`,
  }
}

function getModelOptionsBase(fastMode = false): ModelOption[] {
  return [getDefaultOptionForUser(fastMode), ...getNCodeManagedModelOptions()]
}

export function getModelOptions(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode)

  // Append additional model options fetched during bootstrap.
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add a custom model from the current or initial value if it is not already
  // in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }

  if (
    customModel === null ||
    options.some(opt => modelOptionsReferToSameModel(opt.value, customModel))
  ) {
    return filterModelOptionsByAllowlist(options)
  }

  const ncodeModel = resolveNCodeManagedModel(customModel)
  if (ncodeModel) {
    options.push({
      value: customModel,
      label: ncodeModel.label,
      description: `${ncodeModel.description} (${ncodeModel.model})`,
    })
  } else {
    options.push({
      value: customModel,
      label: customModel,
      description: 'Custom model',
    })
  }

  return filterModelOptionsByAllowlist(options)
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options // No restrictions
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
