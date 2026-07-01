import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { AuthRuntimeError } from './errors.js'
import type { ResolvedAuthSession } from './types.js'

type BuildFirstPartyHeadersFromSessionInput = {
  apiKey?: string
  includeApiKeyHeader?: boolean
  session: ResolvedAuthSession
}

export function buildFirstPartyHeadersFromSession({
  apiKey,
  includeApiKeyHeader,
  session,
}: BuildFirstPartyHeadersFromSessionInput): Record<string, string> {
  const headers: Record<string, string> = {}

  if (session.headersKind === 'bearer') {
    const bearerValue =
      session.principalSource === 'api_key_helper'
        ? session.apiKey
        : session.accessToken
    if (!bearerValue) {
      throw new AuthRuntimeError({
        code: 'service_credential_invalid',
        message: 'Bearer-backed auth session did not contain a usable credential.',
        userMessage: session.recoveryMessage ?? 'Check the configured credential and try again.',
        recoveryAction: session.recoveryAction,
      })
    }
    headers.Authorization = `Bearer ${bearerValue}`
    headers['anthropic-beta'] = OAUTH_BETA_HEADER
  }

  if (includeApiKeyHeader) {
    const resolvedApiKey =
      apiKey ??
      (session.rawApiKeySource === 'OPENAI_API_KEY' ? undefined : session.apiKey)
    if (resolvedApiKey) {
      headers['x-api-key'] = resolvedApiKey
    }
  }

  return headers
}
