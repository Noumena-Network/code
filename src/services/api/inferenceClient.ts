import type Anthropic from '@anthropic-ai/sdk'
import {
  getAPIProvider,
  getActiveProviderEndpointForModel,
  getNoumenaBaseUrl,
  isFirstPartyNoumenaBaseUrl,
} from '../../utils/model/providers.js'
import {
  getAnthropicClient,
  getFirstPartyRequestHeaders,
  getWrappedClientFetch,
} from './client.js'
import { OpenAICompatInferenceClient } from './openAICompatInferenceClient.js'
import { getNCodeManagedModelBaseUrl } from '../../utils/model/ncodeModels.js'

export type InferenceCreateMessageArgs = Parameters<
  Anthropic['beta']['messages']['create']
>
export type InferenceCreateMessageResult = ReturnType<
  Anthropic['beta']['messages']['create']
>

export type InferenceCountTokensArgs = Parameters<
  Anthropic['beta']['messages']['countTokens']
>
export type InferenceCountTokensResult = ReturnType<
  Anthropic['beta']['messages']['countTokens']
>

export type InferenceListModelsArgs = Parameters<Anthropic['models']['list']>
export type InferenceListModelsResult = ReturnType<Anthropic['models']['list']>

/**
 * `code/`'s inference seam must preserve the full caller-visible information
 * set, even if Noumena later changes the transport or payload format.
 *
 * Keep the methods below aligned with what current call sites actually observe:
 * - `createMessage()` result identity plus `.withResponse()` / `.asResponse()`
 * - `countTokens()` response fields
 * - `listModels()` async iteration shape
 */
export interface InferenceClient {
  createMessage(...args: InferenceCreateMessageArgs): InferenceCreateMessageResult
  countTokens(...args: InferenceCountTokensArgs): InferenceCountTokensResult
  listModels(...args: InferenceListModelsArgs): InferenceListModelsResult
}

class AnthropicInferenceClient implements InferenceClient {
  constructor(private readonly anthropic: Anthropic) {}

  createMessage(
    ...args: InferenceCreateMessageArgs
  ): InferenceCreateMessageResult {
    return this.anthropic.beta.messages.create(...args)
  }

  countTokens(
    ...args: InferenceCountTokensArgs
  ): InferenceCountTokensResult {
    return this.anthropic.beta.messages.countTokens(...args)
  }

  listModels(...args: InferenceListModelsArgs): InferenceListModelsResult {
    return this.anthropic.models.list(...args)
  }
}

function getLegacyOpenAICompatBaseUrl(): string | undefined {
  const legacyBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!legacyBaseUrl) {
    return undefined
  }
  return isFirstPartyNoumenaBaseUrl() ? undefined : legacyBaseUrl
}

export async function getInferenceClient(
  args: Parameters<typeof getAnthropicClient>[0],
): Promise<InferenceClient> {
  // BYOK provider registry (see docs/design/PROVIDERS_REGISTRY.md): when a
  // model ID is provided and the operator has declared it in
  // .ncode/settings.json, route through OpenAICompatibility with that
  // entry's baseURL + bearer auth. When the model isn't in the registry,
  // falls through to the firstParty/Anthropic-native path.
  const registryEndpoint = args.model
    ? getActiveProviderEndpointForModel(args.model)
    : undefined
  if (registryEndpoint) {
    const fetch = getWrappedClientFetch(args.fetchOverride, args.source)
    return new OpenAICompatInferenceClient({
      baseURL: registryEndpoint.baseURL,
      headers: { Authorization: `Bearer ${registryEndpoint.apiKey}` },
      ...(fetch ? { fetch } : {}),
    })
  }

  const provider = getAPIProvider()

  if (provider === 'firstParty') {
    const managedModelBaseURL = getNCodeManagedModelBaseUrl(args.model)
    const configuredCompatBaseURL =
      getNoumenaBaseUrl() ?? getLegacyOpenAICompatBaseUrl()
    const baseURL = managedModelBaseURL ?? configuredCompatBaseURL
    if (baseURL) {
      const headers = await getFirstPartyRequestHeaders(
        args.apiKey
          ? {
              apiKey: args.apiKey,
              includeApiKeyHeader: true,
            }
          : {},
      )
      const fetch = getWrappedClientFetch(args.fetchOverride, args.source)
      return new OpenAICompatInferenceClient({
        baseURL,
        headers,
        ...(fetch ? { fetch } : {}),
      })
    }
  }

  return new AnthropicInferenceClient(await getAnthropicClient(args))
}
