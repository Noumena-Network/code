import type { EffortLevel } from '../../entrypoints/sdk/runtimeTypes.js'

export type NCodeManagedModelProfile = {
  primaryAlias: string
  aliases: readonly string[]
  model: string
  label: string
  description: string
  defaultEffortLevel: EffortLevel
  supportsMaxEffort: boolean
  // Usable prompt budget exposed to ncode. This is intentionally below the
  // model/server max sequence length so output, reasoning, and tool-loop
  // continuations have headroom.
  contextWindow: number
  defaultMaxTokens: number
  upperMaxTokensLimit: number
  baseUrl: string
}

export const NCODE_MANAGED_MODEL_MAX_PROMPT_TOKENS = 200_000
export const NCODE_MANAGED_MODEL_MAX_SEQUENCE_TOKENS = 256_000
export const NCODE_MANAGED_MODEL_MAX_TOKENS = 256_000
export const KIMI_2_7_CODER_BASE_URL = 'https://api.noumena.com'
export const KIMI_2_7_CODER_MODEL = '/data/models/hf/moonshotai__Kimi-K2.7-Code'

// K2.6 is internal-only and not available in public/OSS builds. Keep both the
// model identifier and base URL out of the public profile list; configure them
// through internal deployment/runtime configuration only.

export const NCODE_MANAGED_MODEL_PROFILES = [
  {
    primaryAlias: 'kimi-2.7-coder',
    aliases: [
      'kimi 2.7 coder',
      'kimi-2.7-coder',
      'kimi-2.7',
      'k2.7',
      'kimi-coder',
    ] as const,
    model: KIMI_2_7_CODER_MODEL,
    label: 'Kimi 2.7 Coder',
    description: 'Production coding model with thinking support',
    defaultEffortLevel: 'high',
    supportsMaxEffort: false,
    contextWindow: NCODE_MANAGED_MODEL_MAX_PROMPT_TOKENS,
    defaultMaxTokens: NCODE_MANAGED_MODEL_MAX_TOKENS,
    upperMaxTokensLimit: NCODE_MANAGED_MODEL_MAX_TOKENS,
    baseUrl: KIMI_2_7_CODER_BASE_URL,
  },
] as const satisfies readonly NCodeManagedModelProfile[]

export const NCODE_MANAGED_MODEL_ALIASES: readonly string[] =
  NCODE_MANAGED_MODEL_PROFILES.flatMap(profile => [...profile.aliases])

export function isNCodeManagedModelAlias(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return NCODE_MANAGED_MODEL_ALIASES.includes(normalized)
}

export function resolveNCodeManagedModel(
  model: string | undefined,
): NCodeManagedModelProfile | undefined {
  if (!model) return undefined
  const normalized = model.trim().toLowerCase()
  return NCODE_MANAGED_MODEL_PROFILES.find(profile => {
    if (normalized === profile.model.toLowerCase()) return true
    if ((profile.aliases as readonly string[]).includes(normalized)) return true
    return normalized.includes(profile.model.toLowerCase())
  })
}

export function getNCodeManagedModelOptions(): Array<{
  value: string
  label: string
  description: string
  descriptionForModel: string
}> {
  return NCODE_MANAGED_MODEL_PROFILES.map(profile => ({
    value: profile.primaryAlias,
    label: profile.label,
    description: profile.description,
    descriptionForModel: `${profile.description} (${profile.model})`,
  }))
}

export function getNCodeManagedModelBaseUrl(
  model: string | undefined,
): string | undefined {
  const profile = resolveNCodeManagedModel(model)
  if (!profile) {
    return undefined
  }
  return profile.baseUrl
}
