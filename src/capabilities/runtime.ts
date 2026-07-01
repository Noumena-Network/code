// Copyright 2026 Noumena, Inc. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime capability resolution.
 *
 * Bridges the capability model to the live auth/session state.
 * This module is the ONLY place that imports from auth/runtime;
 * capabilities/index.ts should not import auth directly.
 */

import { getAuthRuntime } from '../auth/runtime/AuthRuntime.js'
import type { AuthProvider, AccessMode } from './types.js'
import {
  getDirectApiKeyProviderKind,
  isAnthropicDirectApiKeySource,
  isOpenAIDirectApiKeySource,
} from '../utils/authEnv.js'

/**
 * Determine the active auth provider from the current auth session.
 *
 * Maps auth-runtime principal sources to capability-model AuthProviders.
 */
export function getAuthProvider(): AuthProvider {
  try {
    const session = getAuthRuntime().getCurrentSession()
    const source = session.principalSource

    if (source === 'managed_oauth') {
      return 'noumena-managed'
    }

    if (
      source === 'console_api_key' ||
      source === 'api_key_helper' ||
      (source === 'direct_api_key_env' &&
        !isAnthropicDirectApiKeySource(session.rawApiKeySource) &&
        !isOpenAIDirectApiKeySource(session.rawApiKeySource))
    ) {
      return 'noumena-apikey'
    }

    if (
      source === 'third_party_provider' ||
      source === 'external_bearer_compat' ||
      (source === 'direct_api_key_env' &&
        isOpenAIDirectApiKeySource(session.rawApiKeySource))
    ) {
      return 'byok-openai'
    }

    if (
      source === 'direct_api_key_env' &&
      isAnthropicDirectApiKeySource(session.rawApiKeySource)
    ) {
      return 'byok-anthropic'
    }
  } catch {
    // Auth runtime not initialized yet — fall through to env-based heuristics
  }

  // Fallback: detect from environment using the same precedence as authEnv.
  switch (getDirectApiKeyProviderKind()) {
    case 'noumena':
      return 'noumena-apikey'
    case 'anthropic':
      return 'byok-anthropic'
    case 'openai_compat':
      return 'byok-openai'
  }

  // Default: assume noumena-managed if nothing else is set and we're not public
  if (BUILD_SPIN_REFERENCE !== 'public') {
    return 'noumena-managed'
  }

  return 'byok-anthropic'
}

/**
 * Detect whether the current session is remote or direct.
 */
export function getAccessMode(): AccessMode {
  if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) {
    return 'remote'
  }
  return 'direct'
}

// Reference-only copy of BUILD_SPIN for fallback heuristics above.
// The canonical constant lives in index.ts to avoid a circular import.
const BUILD_SPIN_REFERENCE: string =
  (process.env.NCODE_BUILD_MODE as string | undefined) ?? 'public'
