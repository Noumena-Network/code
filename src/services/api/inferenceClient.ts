import type Anthropic from '@anthropic-ai/sdk'
import {
  getAPIProvider,
  getCustomProviderApiKey,
  getCustomProviderBaseUrl,
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
  const provider = getAPIProvider()

  if (provider === 'custom') {
    const baseURL = getCustomProviderBaseUrl()
    const apiKey = getCustomProviderApiKey()
    if (!baseURL || !apiKey) {
      throw new Error(
        'Custom provider enabled but NCODE_CUSTOM_PROVIDER_URL or NCODE_CUSTOM_PROVIDER_API_KEY is missing or empty',
      )
    }
    const fetch = getWrappedClientFetch(args.fetchOverride, args.source)
    return new OpenAICompatInferenceClient({
      baseURL,
      headers: { Authorization: `Bearer ${apiKey}` },
      ...(fetch ? { fetch } : {}),
    })
  }

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
