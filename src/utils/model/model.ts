// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Noumena-only model resolution. Legacy third-party provider branches and
 * Claude-family model grids have been removed.
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { has1mContext } from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { resolveOverriddenModel } from './modelStrings.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  getAntModelOverrideConfig,
  resolveAntModel,
} from './antModels.js'
import {
  KIMI_2_7_CODER_MODEL,
  resolveNCodeManagedModel,
} from './ncodeModels.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'
import { isInternalBuild } from 'src/capabilities/static.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

function getConfiguredMainModelEnv(): string | undefined {
  return process.env.NOUMENA_MODEL
}

function getConfiguredSmallFastModelEnv(): string | undefined {
  return process.env.NOUMENA_SMALL_FAST_MODEL
}

function getConfiguredDefaultOpusModelEnv(): string | undefined {
  return process.env.NOUMENA_DEFAULT_OPUS_MODEL
}

function getConfiguredDefaultFlashModelEnv(): string | undefined {
  return (
    process.env.NOUMENA_DEFAULT_FLASH_MODEL ||
    process.env.NOUMENA_DEFAULT_SONNET_MODEL
  )
}

function getConfiguredDefaultHaikuModelEnv(): string | undefined {
  return process.env.NOUMENA_DEFAULT_HAIKU_MODEL
}

/**
 * Returns the canonical Noumena-managed model identifier.
 */
function getDefaultNoumenaModel(): ModelName {
  return KIMI_2_7_CODER_MODEL
}

export function getSmallFastModel(): ModelName {
  return getConfiguredSmallFastModelEnv() || getDefaultNoumenaModel()
}

export function isNonCustomOpusModel(_model: ModelName): boolean {
  return false
}

export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = getConfiguredMainModelEnv() || settings.model || undefined
  }

  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

export function getBestModel(): ModelName {
  return getDefaultNoumenaModel()
}

export function getDefaultOpusModel(): ModelName {
  return getConfiguredDefaultOpusModelEnv() || getDefaultNoumenaModel()
}

export function getDefaultFlashModel(): ModelName {
  return getConfiguredDefaultFlashModelEnv() || getDefaultNoumenaModel()
}

export function getDefaultHaikuModel(): ModelName {
  return getConfiguredDefaultHaikuModelEnv() || getDefaultNoumenaModel()
}

export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { mainLoopModel } = params
  return mainLoopModel
}

export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // Internal Ant builds may override the default via feature flags.
  if (isInternalBuild()) {
    return getAntModelOverrideConfig()?.defaultModel ?? 'kimi-2.7-coder'
  }

  // All first-party Noumena sessions use the managed Kimi model.
  return 'kimi-2.7-coder'
}

export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

export function isOpus1mMergeEnabled(): boolean {
  return false
}

export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  const ncodeModel = resolveNCodeManagedModel(name)
  if (ncodeModel) {
    return ncodeModel.label
  }
  return name.toLowerCase()
}

export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

export function getClaudeAiUserDefaultModelDescription(_fastMode = false): string {
  return 'Kimi 2.7 Coder · Best for everyday tasks'
}

export function renderDefaultModelSetting(setting: ModelName | ModelAlias): string {
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getOpus46PricingSuffix(_fastMode: boolean): string {
  return ''
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

export function getPublicModelDisplayName(model: ModelName): string | null {
  const ncodeModel = resolveNCodeManagedModel(model)
  if (ncodeModel) {
    return ncodeModel.label
  }
  return null
}

function maskModelCodename(baseName: string): string {
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }

  if (isInternalBuild()) {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }

  return model
}

export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `NCode ${publicName}`
  }
  return `NCode (${model})`
}

export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m\]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'best':
        return getBestModel()
      case 'sonnet':
      case 'opus':
      case 'haiku':
      case 'opusplan':
        // Legacy Anthropic aliases are remapped to the managed Kimi model for
        // one release cycle while users migrate persisted configs.
        return getDefaultNoumenaModel() + (has1mTag ? '[1m]' : '')
      default:
        // Fall through to Noumena-managed model resolution.
    }
  }

  const ncodeModel = resolveNCodeManagedModel(modelString)
  if (ncodeModel) {
    return ncodeModel.model
  }

  if (isInternalBuild()) {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m\]$/i, '').trim()
    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }
  }

  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

export function resolveSkillModelOverride(
  skillModel: string,
  _currentModel: string,
): string {
  // 1M context variants are not supported on Noumena-managed models.
  return skillModel
}

export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (isInternalBuild()) {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

export function getMarketingNameForModel(modelId: string): string | undefined {
  const ncodeModel = resolveNCodeManagedModel(modelId)
  if (ncodeModel) {
    return ncodeModel.label
  }
  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
