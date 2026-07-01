export type DirectApiKeyEnvVarName =
  | 'NOUMENA_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'OPENAI_API_KEY'
export type DirectApiKeyProviderMode = 'noumena_managed' | 'byok_static_env'
export type DirectApiKeyProviderKind =
  | 'noumena'
  | 'anthropic'
  | 'openai_compat'

export function getDirectApiKeyEnvVarName(): DirectApiKeyEnvVarName | null {
  if (process.env.NOUMENA_API_KEY) {
    return 'NOUMENA_API_KEY'
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return 'ANTHROPIC_API_KEY'
  }
  if (process.env.OPENAI_API_KEY) {
    return 'OPENAI_API_KEY'
  }
  return null
}

export function getDirectApiKeyEnvValue(): string | undefined {
  const envVarName = getDirectApiKeyEnvVarName()
  return envVarName ? process.env[envVarName] : undefined
}

export function getDirectApiKeyProviderMode(
  envVarName: DirectApiKeyEnvVarName | null = getDirectApiKeyEnvVarName(),
): DirectApiKeyProviderMode | null {
  if (envVarName === 'NOUMENA_API_KEY') {
    return 'noumena_managed'
  }
  if (envVarName === 'ANTHROPIC_API_KEY') {
    return 'byok_static_env'
  }
  if (envVarName === 'OPENAI_API_KEY') {
    return 'byok_static_env'
  }
  return null
}

export function isDirectApiKeyEnvVarName(
  value: string | null | undefined,
): value is DirectApiKeyEnvVarName {
  return (
    value === 'NOUMENA_API_KEY' ||
    value === 'ANTHROPIC_API_KEY' ||
    value === 'OPENAI_API_KEY'
  )
}

export function getDirectApiKeyProviderKind(
  envVarName: DirectApiKeyEnvVarName | null = getDirectApiKeyEnvVarName(),
): DirectApiKeyProviderKind | null {
  switch (envVarName) {
    case 'NOUMENA_API_KEY':
      return 'noumena'
    case 'ANTHROPIC_API_KEY':
      return 'anthropic'
    case 'OPENAI_API_KEY':
      return 'openai_compat'
    default:
      return null
  }
}

export function getDirectApiKeyProviderKindForSource(
  source: string | null | undefined,
): DirectApiKeyProviderKind | null {
  return isDirectApiKeyEnvVarName(source)
    ? getDirectApiKeyProviderKind(source)
    : null
}

export function isOpenAIDirectApiKeyEnvVar(
  envVarName: DirectApiKeyEnvVarName | null = getDirectApiKeyEnvVarName(),
): boolean {
  return getDirectApiKeyProviderKind(envVarName) === 'openai_compat'
}

export function isOpenAIDirectApiKeySource(
  source: string | null | undefined,
): boolean {
  return getDirectApiKeyProviderKindForSource(source) === 'openai_compat'
}

export function isAnthropicDirectApiKeySource(
  source: string | null | undefined,
): boolean {
  return getDirectApiKeyProviderKindForSource(source) === 'anthropic'
}
