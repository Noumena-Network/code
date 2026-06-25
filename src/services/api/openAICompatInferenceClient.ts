import type { BetaMessage, BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { Stream as SDKStream } from '@anthropic-ai/sdk/streaming.mjs'
import {
  createNativeOpenAICompatWsV2Transport,
  shouldUseOpenAICompatWsV2,
  type OpenAICompatWsV2Transport,
} from './openAICompatWsV2Native.js'
import { randomUUID } from 'crypto'
import { parseSSEFrames } from '../../cli/transports/SSETransport.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import {
  getNCodeManagedModelBaseUrl,
  resolveNCodeManagedModel,
} from '../../utils/model/ncodeModels.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { swallow } from '../../utils/swallow.js'
import type {
  InferenceClient,
  InferenceCountTokensArgs,
  InferenceCountTokensResult,
  InferenceCreateMessageArgs,
  InferenceCreateMessageResult,
  InferenceListModelsArgs,
  InferenceListModelsResult,
} from './inferenceClient.js'

type FetchLike = typeof fetch

type OpenAICompatInferenceClientOptions = {
  baseURL: string
  fetch?: FetchLike
  headers?: HeadersInit
  backendCapabilities?: Partial<OpenAICompatBackendCapabilities>
  wsV2Transport?: OpenAICompatWsV2Transport | null
}

type OpenAICompatRequestPolicy = {
  disableReasoning: boolean
}

type OpenAICompatReasoningTransport =
  | 'separate_reasoning'
  | 'unsafe_visible_content'

type OpenAICompatBackendCapabilities = {
  reasoningTransport: OpenAICompatReasoningTransport
}

export class OpenAICompatBackendAbortError extends Error {
  constructor(context: 'unary' | 'stream') {
    super(`OpenAI compat ${context} response aborted before assistant content`)
    this.name = 'OpenAICompatBackendAbortError'
  }
}

export class OpenAICompatMalformedToolOutputError extends Error {
  constructor(public readonly context: 'unary' | 'stream') {
    super(`Malformed ${context} tool output leaked from backend response`)
    this.name = 'OpenAICompatMalformedToolOutputError'
  }
}

export class OpenAICompatHTTPError extends Error {
  readonly status: number
  readonly statusText: string

  constructor(status: number, statusText: string) {
    super(`OpenAI compat inference request failed: ${status} ${statusText}`)
    this.name = 'OpenAICompatHTTPError'
    this.status = status
    this.statusText = statusText
  }
}

export class OpenAICompatTransportError extends Error {
  readonly code: string | undefined

  constructor(
    message: string,
    public readonly originalError: unknown,
  ) {
    super(`OpenAI compat inference transport failed: ${message}`)
    this.name = 'OpenAICompatTransportError'
    this.code = getErrorCode(originalError)
  }
}

export function isOpenAICompatBackendAbortError(
  error: unknown,
): error is OpenAICompatBackendAbortError {
  return error instanceof OpenAICompatBackendAbortError
}

export function isOpenAICompatMalformedToolOutputError(
  error: unknown,
): error is OpenAICompatMalformedToolOutputError {
  return error instanceof OpenAICompatMalformedToolOutputError
}

export function isOpenAICompatRetryableHTTPError(
  error: unknown,
): error is OpenAICompatHTTPError {
  return error instanceof OpenAICompatHTTPError && error.status >= 500
}

export function isOpenAICompatRetryableTransportError(
  error: unknown,
): error is OpenAICompatTransportError {
  return error instanceof OpenAICompatTransportError
}

function getErrorCode(error: unknown): string | undefined {
  let current = error
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') {
      return undefined
    }
    if (
      'code' in current &&
      typeof (current as { code?: unknown }).code === 'string'
    ) {
      return (current as { code: string }).code
    }
    if (!('cause' in current) || (current as { cause?: unknown }).cause === current) {
      return undefined
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isAbortFinishReason(finishReason: string | null | undefined): boolean {
  return finishReason?.trim().toLowerCase() === 'abort'
}

function createBackendAbortError(
  context: 'unary' | 'stream',
): OpenAICompatBackendAbortError {
  return new OpenAICompatBackendAbortError(context)
}

type OpenAIChatCompletionRequest = {
  model: string
  messages: Array<Record<string, unknown>>
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  stop?: string[]
  stream?: boolean
  stream_options?: {
    include_usage?: boolean
    continuous_usage_stats?: boolean
  }
  tools?: Array<Record<string, unknown>>
  tool_choice?: string | Record<string, unknown>
  response_format?: Record<string, unknown>
  reasoning_effort?: 'none' | 'medium' | 'high' | 'max'
  separate_reasoning?: boolean
  stream_reasoning?: boolean
  chat_template_kwargs?: Record<string, unknown>
  custom_params?: Record<string, unknown>
}

type OpenAIChatCompletionResponse = {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    message?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id?: string | null
        index?: number | null
        function?: {
          name?: string | null
          arguments?: string | null
        } | null
      }> | null
    } | null
    finish_reason?: string | null
    matched_stop?: unknown
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    } | null
    reasoning_tokens?: number
  } | null
}

type OpenAIStreamChunk = {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: string | null
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id?: string | null
        index?: number | null
        function?: {
          name?: string | null
          arguments?: string | null
        } | null
      }> | null
    } | null
    finish_reason?: string | null
    matched_stop?: unknown
  }>
  usage?: OpenAIChatCompletionResponse['usage']
}

type OpenAIModelsResponse = {
  data?: Array<Record<string, unknown>>
}

const OPENAI_COMPAT_REASONING_TRANSPORT_ENV =
  'NOUMENA_OPENAI_COMPAT_REASONING_TRANSPORT'

function normalizeOpenAICompatModelForAPI(model: string): string {
  return (resolveNCodeManagedModel(model)?.model ?? model).replace(/\[(1|2)m\]/gi, '')
}

function getNoumenaModelRoutingHeader(model: string): string | undefined {
  return resolveNCodeManagedModel(model)?.routingModel
}

function getRequestId(response: Response, fallback?: string): string | null {
  return (
    response.headers.get('request-id') ??
    response.headers.get('x-request-id') ??
    fallback ??
    null
  )
}

function createBaseUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: null,
    speed: null,
  }
}

function mapUsage(usage: OpenAIChatCompletionResponse['usage']) {
  const base = createBaseUsage()
  return {
    ...base,
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  }
}

function mapStopReason(
  finishReason: string | null | undefined,
): BetaMessage['stop_reason'] {
  switch (finishReason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'stop_sequence'
    default:
      return null
  }
}

function normalizeStopSequence(matchedStop: unknown): string | null {
  if (typeof matchedStop !== 'string') {
    return null
  }
  const value = matchedStop.trim()
  return value.length > 0 ? value : null
}

function normalizeToolInput(input: unknown): string {
  if (typeof input === 'string') {
    return input
  }
  return jsonStringify(input)
}

const MALFORMED_TOOL_MARKERS = [
  '<|tool_calls_section_begin|>',
  '<|tool_call_begin|>',
  '<|tool_call_argument_begin|>',
  '<|tool_call_end|>',
  '<|tool_calls_section_end|>',
]
const STRIPPED_VISIBLE_REASONING_MARKERS = ['<think>', '</think>']
const PSEUDO_TOOL_CALL_PATTERN = /functions\.[A-Za-z0-9_]+:\d+\s*\{/
const REACT_PSEUDO_TOOL_PATTERN =
  /(^|\n)\s*Action:\s*[A-Za-z_][A-Za-z0-9_.-]*(\s|\n|$)/
const REACT_PSEUDO_TOOL_INPUT_PATTERN = /(^|\n)\s*Action Input:\s*[{[]/
const XML_PSEUDO_TOOL_REQUEST_PATTERN = /<request>\s*xml/i
const DSML_PSEUDO_TOOL_REQUEST_PATTERN =
  /<｜DSML｜tool_calls>|<\/?tool_calls>|<\/?invoke>|<tool_name>|<parameter\b/i
const VISIBLE_PROTOCOL_TAG_PATTERN =
  /<\/?\s*(analysis|observation|error_feedback|attempt_completion|response|system-reminder)\b|<\/error>|<\|discussion\|>|<\|end\|>/i
const PSEUDO_TOOL_PREFIX_CANDIDATE_PATTERNS = [
  /^functions?\.*[A-Za-z0-9_]*$/,
  /^functions\.[A-Za-z0-9_]+:\d*$/,
  /^functions\.[A-Za-z0-9_]+:\d+\s*$/,
  /^functions\.[A-Za-z0-9_]+:\d+\s*\{$/,
  /^Action:?$/,
  /^Action:\s*[A-Za-z_][A-Za-z0-9_.-]*$/,
  /^Action Input:?$/,
  /^Action Input:\s*$/,
  /^Action Input:\s*[{[]$/,
]

function containsMalformedToolMarker(input: string): boolean {
  return (
    MALFORMED_TOOL_MARKERS.some(marker => input.includes(marker)) ||
    PSEUDO_TOOL_CALL_PATTERN.test(input) ||
    REACT_PSEUDO_TOOL_PATTERN.test(input) ||
    REACT_PSEUDO_TOOL_INPUT_PATTERN.test(input) ||
    XML_PSEUDO_TOOL_REQUEST_PATTERN.test(input) ||
    DSML_PSEUDO_TOOL_REQUEST_PATTERN.test(input) ||
    VISIBLE_PROTOCOL_TAG_PATTERN.test(input)
  )
}

function stripVisibleReasoningMarkers(input: string): string {
  let output = input
  for (const marker of STRIPPED_VISIBLE_REASONING_MARKERS) {
    output = output.split(marker).join('')
  }
  return output
}

function assertNoMalformedToolOutput(
  text: string | null | undefined,
  context: 'unary' | 'stream',
): void {
  const value = text?.trim()
  if (!value) {
    return
  }
  if (containsMalformedToolMarker(value)) {
    throw new OpenAICompatMalformedToolOutputError(context)
  }
}

function getMalformedToolRetainLength(input: string): number {
  let retainLength = 0

  for (const marker of [
    ...MALFORMED_TOOL_MARKERS,
    ...STRIPPED_VISIBLE_REASONING_MARKERS,
    'Action:',
    'Action Input:',
    '<request>',
    '<｜DSML｜tool_calls>',
    '<tool_name>',
    '<parameter',
    '<analysis',
    '<observation',
    '< observation',
    '<error_feedback',
    '<attempt_completion',
    '<response',
    '<system-reminder',
    '<|discussion|>',
  ]) {
    const maxPrefixLength = Math.min(marker.length - 1, input.length)
    for (let prefixLength = maxPrefixLength; prefixLength > 0; prefixLength -= 1) {
      if (input.endsWith(marker.slice(0, prefixLength))) {
        retainLength = Math.max(retainLength, prefixLength)
        break
      }
    }
  }

  const maxPseudoProbeLength = Math.min(input.length, 128)
  for (
    let candidateLength = maxPseudoProbeLength;
    candidateLength > 0;
    candidateLength -= 1
  ) {
    const suffix = input.slice(-candidateLength)
    if (
      'functions.'.startsWith(suffix) ||
      PSEUDO_TOOL_PREFIX_CANDIDATE_PATTERNS.some(pattern => pattern.test(suffix))
    ) {
      retainLength = Math.max(retainLength, candidateLength)
      break
    }
  }

  return retainLength
}

function convertToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string'
        ) {
          return block.text
        }
        return jsonStringify(block)
      })
      .join('\n')
  }
  return jsonStringify(content)
}

function convertUserContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ role: 'user', content }]
  }

  if (!Array.isArray(content)) {
    throw new Error('Unsupported user content format for OpenAI compat client')
  }

  const messages: Array<Record<string, unknown>> = []
  let textParts: string[] = []
  let multimodalParts: Array<Record<string, unknown>> = []

  const flushUserContent = () => {
    if (multimodalParts.length > 0) {
      if (textParts.length > 0) {
        multimodalParts.unshift({
          type: 'text',
          text: textParts.join(''),
        })
      }
      messages.push({ role: 'user', content: multimodalParts })
      textParts = []
      multimodalParts = []
      return
    }
    if (textParts.length > 0) {
      messages.push({ role: 'user', content: textParts.join('') })
      textParts = []
    }
  }

  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) {
      throw new Error('Unsupported user content block in OpenAI compat client')
    }

    switch (block.type) {
      case 'text':
        if ('text' in block && typeof block.text === 'string') {
          if (multimodalParts.length > 0) {
            multimodalParts.push({ type: 'text', text: block.text })
          } else {
            textParts.push(block.text)
          }
        }
        break
      case 'image':
        if (
          'source' in block &&
          block.source &&
          typeof block.source === 'object' &&
          'type' in block.source &&
          block.source.type === 'base64' &&
          'media_type' in block.source &&
          'data' in block.source &&
          typeof block.source.media_type === 'string' &&
          typeof block.source.data === 'string'
        ) {
          multimodalParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          })
          break
        }
        throw new Error('Unsupported image block in OpenAI compat client')
      case 'tool_result':
        flushUserContent()
        messages.push({
          role: 'tool',
          tool_call_id:
            'tool_use_id' in block && typeof block.tool_use_id === 'string'
              ? block.tool_use_id
              : randomUUID(),
          content: convertToolResultContent(
            'content' in block ? block.content : undefined,
          ),
        })
        break
      default:
        // Preserve unsupported request data in custom params, but keep the live
        // message path fail-loud instead of silently collapsing semantics.
        throw new Error(
          `Unsupported user content block type for OpenAI compat client: ${String(block.type)}`,
        )
    }
  }

  flushUserContent()
  return messages
}

function convertAssistantContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ role: 'assistant', content }]
  }

  if (!Array.isArray(content)) {
    throw new Error(
      'Unsupported assistant content format for OpenAI compat client',
    )
  }

  const textParts: string[] = []
  const reasoningParts: string[] = []
  const toolCalls: Array<Record<string, unknown>> = []

  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) {
      throw new Error(
        'Unsupported assistant content block in OpenAI compat client',
      )
    }

    switch (block.type) {
      case 'text':
        if ('text' in block && typeof block.text === 'string') {
          textParts.push(block.text)
        }
        break
      case 'thinking':
        if ('thinking' in block && typeof block.thinking === 'string') {
          reasoningParts.push(block.thinking)
        }
        break
      case 'redacted_thinking':
        break
      case 'tool_use': {
        const name =
          'name' in block && typeof block.name === 'string' ? block.name : ''
        const id =
          'id' in block && typeof block.id === 'string' ? block.id : randomUUID()
        const rawInput = 'input' in block ? block.input : {}
        toolCalls.push({
          id,
          type: 'function',
          function: {
            name,
            arguments: normalizeToolInput(rawInput),
          },
        })
        break
      }
      default:
        throw new Error(
          `Unsupported assistant content block type for OpenAI compat client: ${String(block.type)}`,
        )
    }
  }

  return [
    {
      role: 'assistant',
      ...(textParts.length > 0
        ? { content: textParts.join('') }
        : toolCalls.length > 0
          ? { content: null }
          : {}),
      ...(reasoningParts.length > 0
        ? { reasoning_content: reasoningParts.join('') }
        : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ]
}

function convertMessages(
  system: unknown,
  messages: unknown,
): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = []

  if (typeof system === 'string' && system.length > 0) {
    converted.push({ role: 'system', content: system })
  } else if (Array.isArray(system) && system.length > 0) {
    const text = system
      .map(block => {
        if (
          block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string'
        ) {
          return block.text
        }
        throw new Error(
          'Unsupported system block type for OpenAI compat client',
        )
      })
      .join('')
    if (text.length > 0) {
      converted.push({ role: 'system', content: text })
    }
  }

  if (!Array.isArray(messages)) {
    throw new Error('Inference request messages must be an array')
  }

  for (const message of messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      !('role' in message) ||
      typeof message.role !== 'string'
    ) {
      throw new Error('Unsupported message shape for OpenAI compat client')
    }

    if (message.role === 'user') {
      converted.push(...convertUserContent('content' in message ? message.content : ''))
      continue
    }

    if (message.role === 'assistant') {
      converted.push(
        ...convertAssistantContent('content' in message ? message.content : ''),
      )
      continue
    }

    throw new Error(
      `Unsupported message role for OpenAI compat client: ${message.role}`,
    )
  }

  return converted
}

function convertTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }

  return tools.map(tool => {
    if (
      !tool ||
      typeof tool !== 'object' ||
      !('name' in tool) ||
      typeof tool.name !== 'string'
    ) {
      throw new Error('Unsupported tool shape for OpenAI compat client')
    }

    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string'
          ? { description: tool.description }
          : {}),
        parameters:
          'input_schema' in tool && tool.input_schema
            ? tool.input_schema
            : { type: 'object', properties: {} },
      },
    }
  })
}

function convertToolChoice(
  toolChoice: unknown,
): OpenAIChatCompletionRequest['tool_choice'] {
  if (!toolChoice) {
    return undefined
  }

  if (typeof toolChoice === 'string') {
    return toolChoice
  }

  if (
    typeof toolChoice === 'object' &&
    toolChoice !== null &&
    'type' in toolChoice
  ) {
    if (toolChoice.type === 'auto') {
      return 'auto'
    }
    if (toolChoice.type === 'any') {
      return 'required'
    }
    if (
      toolChoice.type === 'tool' &&
      'name' in toolChoice &&
      typeof toolChoice.name === 'string'
    ) {
      return {
        type: 'function',
        function: { name: toolChoice.name },
      }
    }
  }

  return undefined
}

function convertOutputConfig(
  outputConfig: unknown,
): OpenAIChatCompletionRequest['response_format'] {
  if (
    !outputConfig ||
    typeof outputConfig !== 'object' ||
    !('format' in outputConfig) ||
    !outputConfig.format ||
    typeof outputConfig.format !== 'object'
  ) {
    return undefined
  }

  const format = outputConfig.format as Record<string, unknown>
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name:
          typeof format.name === 'string'
            ? format.name
            : typeof format.schema === 'object' &&
                format.schema &&
                'title' in format.schema &&
                typeof format.schema.title === 'string'
              ? format.schema.title
              : 'Schema',
        schema: format.schema,
        strict: format.strict === true,
      },
    }
  }

  if (format.type === 'json_object') {
    return { type: 'json_object' }
  }

  return undefined
}

function getOpenAICompatReasoningEffort(
  outputConfig: unknown,
): OpenAIChatCompletionRequest['reasoning_effort'] | undefined {
  if (!outputConfig || typeof outputConfig !== 'object') {
    return undefined
  }
  if (!('effort' in outputConfig)) {
    return undefined
  }
  const effort = String(outputConfig.effort).trim().toLowerCase()
  switch (effort) {
    case 'medium':
    case 'high':
    case 'max':
      return effort
    default:
      return undefined
  }
}

export function buildOpenAICompatChatRequest(
  params: InferenceCreateMessageArgs[0],
  options?: {
    policy?: OpenAICompatRequestPolicy
  },
): OpenAIChatCompletionRequest {
  const customParams: Record<string, unknown> = {}
  const disableReasoningForRequest =
    options?.policy?.disableReasoning ??
    resolveOpenAICompatRequestPolicy(params).disableReasoning

  if ('betas' in params && Array.isArray(params.betas) && params.betas.length > 0) {
    customParams.noumena_requested_betas = params.betas
  }
  if ('metadata' in params && params.metadata !== undefined) {
    customParams.noumena_metadata = params.metadata
  }
  if ('context_management' in params && params.context_management !== undefined) {
    customParams.noumena_context_management = params.context_management
  }
  if ('speed' in params && params.speed !== undefined) {
    customParams.noumena_speed = params.speed
  }
  if ('thinking' in params && params.thinking !== undefined) {
    customParams.noumena_original_thinking = params.thinking
  }
  if ('output_config' in params && params.output_config !== undefined) {
    customParams.noumena_original_output_config = params.output_config
  }
  const reasoningEffort =
    !disableReasoningForRequest && params.thinking !== undefined
      ? (getOpenAICompatReasoningEffort(params.output_config) ?? 'high')
      : undefined
  const convertedTools = convertTools(params.tools)
  const convertedToolChoice = convertToolChoice(params.tool_choice)
  const convertedMessages = convertMessages(params.system, params.messages)

  const request: OpenAIChatCompletionRequest = {
    model: normalizeOpenAICompatModelForAPI(params.model),
    messages: convertedMessages,
    max_completion_tokens: params.max_tokens,
    ...(params.max_tokens !== undefined ? { max_tokens: params.max_tokens } : {}),
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    ...(params.stop_sequences ? { stop: params.stop_sequences } : {}),
    ...(params.stream
      ? {
          stream: true,
          stream_options: {
            include_usage: true,
            continuous_usage_stats: false,
          },
        }
      : {}),
    ...(convertedTools ? { tools: convertedTools } : {}),
    ...(convertedToolChoice
      ? { tool_choice: convertedToolChoice }
      : convertedTools
        ? { tool_choice: 'auto' as const }
        : {}),
    ...(convertOutputConfig(params.output_config)
      ? { response_format: convertOutputConfig(params.output_config) }
      : {}),
    ...(!disableReasoningForRequest
      ? {
          separate_reasoning: true,
          stream_reasoning: true,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(reasoningEffort
            ? {
                chat_template_kwargs: {
                  thinking: true,
                  enable_thinking: true,
                },
              }
            : {}),
        }
      : {}),
    ...(disableReasoningForRequest
      ? {
          reasoning_effort: 'none' as const,
          // Kimi K2.5 instant mode is selected at template-render time, so
          // disabled-reasoning requests must also force the non-thinking branch.
          chat_template_kwargs: {
            thinking: false,
            enable_thinking: false,
          },
        }
      : {}),
    ...(Object.keys(customParams).length > 0 ? { custom_params: customParams } : {}),
  }

  return request
}

function normalizeReasoningTransport(
  value: string | null | undefined,
): OpenAICompatReasoningTransport | undefined {
  switch (value?.trim().toLowerCase()) {
    case 'separate':
    case 'separate_reasoning':
    case 'supported':
      return 'separate_reasoning'
    case 'unsafe':
    case 'unsafe_visible_content':
    case 'disabled':
      return 'unsafe_visible_content'
    default:
      return undefined
  }
}

export function resolveOpenAICompatBackendCapabilities(
  baseURL: string,
  overrides?: Partial<OpenAICompatBackendCapabilities>,
): OpenAICompatBackendCapabilities {
  const overrideTransport =
    overrides?.reasoningTransport ??
    normalizeReasoningTransport(
      process.env[OPENAI_COMPAT_REASONING_TRANSPORT_ENV],
    )
  if (overrideTransport) {
    return { reasoningTransport: overrideTransport }
  }

  return { reasoningTransport: 'separate_reasoning' }
}

export function resolveOpenAICompatRequestPolicy(
  params: InferenceCreateMessageArgs[0],
  capabilities: OpenAICompatBackendCapabilities = {
    reasoningTransport: 'separate_reasoning',
  },
): OpenAICompatRequestPolicy {
  if (params.thinking?.type === 'disabled') {
    return { disableReasoning: true }
  }

  if (capabilities.reasoningTransport === 'unsafe_visible_content') {
    return { disableReasoning: true }
  }

  return { disableReasoning: false }
}

function parseToolArguments(rawArguments: string | null | undefined): unknown {
  if (!rawArguments) {
    return {}
  }
  try {
    return JSON.parse(rawArguments)
  } catch {
    return rawArguments
  }
}

function assertAssistantContentPresent(
  context: 'unary' | 'stream',
  stopReason: BetaMessage['stop_reason'],
  contentBlockCount: number,
): void {
  if (stopReason !== 'tool_use' && contentBlockCount === 0) {
    throw new Error(`Malformed ${context} response missing assistant content`)
  }
}

function isCompleteJsonObjectString(value: string): boolean {
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function mergeToolArgumentChunk(previous: string, next: string): string {
  if (!previous) {
    return next
  }
  if (next.startsWith(previous)) {
    return next
  }
  if (previous.startsWith(next)) {
    return previous
  }
  if (isCompleteJsonObjectString(next)) {
    return next
  }
  if (isCompleteJsonObjectString(previous)) {
    return previous
  }
  return previous + next
}

type OpenAIStreamToolCallDelta = NonNullable<
  NonNullable<OpenAIStreamChunk['choices']>[number]['delta']
>['tool_calls'][number]

type OpenAIStreamToolState = {
  contentIndex: number
  id: string
  name?: string
  arguments: string
  started: boolean
}

export function mapOpenAIChatCompletionToAnthropicMessage(
  responseBody: OpenAIChatCompletionResponse,
  response: Response,
  fallbackModel?: string,
  options?: {
    allowReasoning?: boolean
  },
): BetaMessage {
  const allowReasoning = options?.allowReasoning ?? true
  const choice = responseBody.choices?.[0]
  const message = choice?.message
  const content: Array<Record<string, unknown>> = []
  if (isAbortFinishReason(choice?.finish_reason)) {
    throw createBackendAbortError('unary')
  }
  if (
    choice?.finish_reason === 'tool_calls' &&
    (!message?.tool_calls || message.tool_calls.length === 0)
  ) {
    throw new Error('Malformed unary tool response missing tool_calls')
  }

  const normalizedMessageContent = message?.content ?? null
  const sanitizedMessageContent =
    typeof normalizedMessageContent === 'string'
      ? stripVisibleReasoningMarkers(normalizedMessageContent)
      : null
  if (sanitizedMessageContent !== null) {
    assertNoMalformedToolOutput(sanitizedMessageContent, 'unary')
  }

  if (message?.reasoning_content) {
    assertNoMalformedToolOutput(message.reasoning_content, 'unary')
  }

  if (allowReasoning && message?.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: message.reasoning_content,
      signature: '',
    })
  }

  if (sanitizedMessageContent) {
    content.push({
      type: 'text',
      text: sanitizedMessageContent,
    })
  }

  for (const toolCall of message?.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id ?? randomUUID(),
      name:
        'function' in toolCall
          ? toolCall.function?.name ?? ''
          : toolCall.name,
      input: parseToolArguments(
        'function' in toolCall ? toolCall.function?.arguments : toolCall.arguments,
      ),
    })
  }

  const anthropicMessage = {
    id: responseBody.id ?? randomUUID(),
    type: 'message',
    role: 'assistant',
    model: responseBody.model ?? fallbackModel ?? 'unknown',
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: normalizeStopSequence(choice?.matched_stop),
    usage: mapUsage(responseBody.usage),
    _request_id: getRequestId(response, responseBody.id),
  }

  assertAssistantContentPresent('unary', anthropicMessage.stop_reason, content.length)

  return anthropicMessage as BetaMessage
}

async function* streamOpenAIChatCompletionAsAnthropicEvents(
  response: Response,
  fallbackModel?: string,
  controller?: AbortController,
  allowReasoning: boolean = false,
): AsyncGenerator<BetaRawMessageStreamEvent> {
  if (!response.body) {
    throw new Error('Streaming response body missing')
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  const streamController = controller ?? new AbortController()
  const onAbort = () => {
    swallow(reader.cancel(), 'cancel reader on abort')
  }
  if (streamController.signal.aborted) {
    onAbort()
    return
  }
  streamController.signal.addEventListener('abort', onAbort, { once: true })
  let buffer = ''
  let messageId = randomUUID()
  let messageModel = fallbackModel ?? 'unknown'
  let finalUsage = createBaseUsage()
  let finalStopReason: BetaMessage['stop_reason'] = null
  let finalStopSequence: string | null = null
  let sawDoneSentinel = false
  let sawFinishReason = false
  let emittedMessageStart = false
  let nextIndex = 0
  let textIndex: number | null = null
  let thinkingIndex: number | null = null
  let textValidationBuffer = ''
  let reasoningValidationBuffer = ''
  let lastFlushedTextDelta: string | null = null
  const openTools = new Map<string, OpenAIStreamToolState>()
  const toolKeyByIndex = new Map<number, string>()
  const toolKeyById = new Map<string, string>()
  const syntheticToolKeyByPosition = new Map<number, string>()
  let nextSyntheticToolKey = 0
  const stoppedContentIndices = new Set<number>()

  const flushTextDelta = function* (
    text: string,
  ): AsyncGenerator<BetaRawMessageStreamEvent> {
    if (!text) {
      return
    }
    if (textIndex === null) {
      textIndex = nextIndex++
      yield {
        type: 'content_block_start',
        index: textIndex,
        content_block: {
          type: 'text',
          text: '',
        },
      } as BetaRawMessageStreamEvent
    }
    yield {
      type: 'content_block_delta',
      index: textIndex,
      delta: {
        type: 'text_delta',
        text,
      },
    } as BetaRawMessageStreamEvent
    lastFlushedTextDelta = text
  }

  const ensureMessageStart = () => {
    if (emittedMessageStart) {
      return
    }
    emittedMessageStart = true
    return {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: messageModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: createBaseUsage(),
      },
    } as BetaRawMessageStreamEvent
  }

  const stopContentBlock = (index: number): BetaRawMessageStreamEvent | null => {
    if (stoppedContentIndices.has(index)) {
      return null
    }
    stoppedContentIndices.add(index)
    return {
      type: 'content_block_stop',
      index,
    } as BetaRawMessageStreamEvent
  }

  const resolveToolKey = (
    toolCall: OpenAIStreamToolCallDelta,
    position: number,
  ): string => {
    if (toolCall.index !== undefined && toolCall.index !== null) {
      const existing = toolKeyByIndex.get(toolCall.index)
      if (existing) {
        if (toolCall.id) {
          toolKeyById.set(toolCall.id, existing)
        }
        return existing
      }
      const key = `index:${toolCall.index}`
      toolKeyByIndex.set(toolCall.index, key)
      if (toolCall.id) {
        toolKeyById.set(toolCall.id, key)
      }
      return key
    }

    if (toolCall.id) {
      const existing = toolKeyById.get(toolCall.id)
      if (existing) {
        return existing
      }
      const key = `id:${toolCall.id}`
      toolKeyById.set(toolCall.id, key)
      return key
    }

    const existing = syntheticToolKeyByPosition.get(position)
    if (existing) {
      return existing
    }
    const key = `synthetic:${nextSyntheticToolKey++}`
    syntheticToolKeyByPosition.set(position, key)
    return key
  }

  const ensureToolState = (
    toolKey: string,
    toolCall: OpenAIStreamToolCallDelta,
  ): OpenAIStreamToolState => {
    const existing = openTools.get(toolKey)
    if (existing) {
      if (!existing.name && toolCall.function?.name) {
        existing.name = toolCall.function.name
      }
      if (toolCall.id && existing.id.startsWith('generated-')) {
        existing.id = toolCall.id
      }
      return existing
    }

    const state: OpenAIStreamToolState = {
      contentIndex: nextIndex++,
      id: toolCall.id ?? `generated-${randomUUID()}`,
      name: toolCall.function?.name ?? undefined,
      arguments: '',
      started: false,
    }
    openTools.set(toolKey, state)
    return state
  }

  const emitToolStartIfReady = (
    state: OpenAIStreamToolState,
  ): BetaRawMessageStreamEvent | null => {
    if (state.started || !state.name) {
      return null
    }
    state.started = true
    return {
      type: 'content_block_start',
      index: state.contentIndex,
      content_block: {
        type: 'tool_use',
        id: state.id,
        name: state.name,
        input: '',
      },
    } as BetaRawMessageStreamEvent
  }

  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (error) {
        if (streamController.signal.aborted || isAbortLike(error)) {
          return
        }
        throw new OpenAICompatTransportError(errorMessage(error), error)
      }
      const { done, value } = result
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      const parsed = parseSSEFrames(buffer)
      buffer = parsed.remaining

      for (const frame of parsed.frames) {
        if (!frame.data) {
          continue
        }
        if (frame.data === '[DONE]') {
          sawDoneSentinel = true
          continue
        }

        const chunk = JSON.parse(frame.data) as OpenAIStreamChunk
        if (chunk.id) {
          messageId = chunk.id
        }
        if (chunk.model) {
          messageModel = chunk.model
        }

        if (chunk.usage) {
          finalUsage = mapUsage(chunk.usage)
        }

        const choice = chunk.choices?.[0]
        if (!choice) {
          continue
        }

        if (choice.finish_reason) {
          if (isAbortFinishReason(choice.finish_reason)) {
            throw createBackendAbortError('stream')
          }
          sawFinishReason = true
          finalStopReason = mapStopReason(choice.finish_reason)
          finalStopSequence = normalizeStopSequence(choice.matched_stop)
        }

        const delta = choice.delta
        if (!delta) {
          continue
        }

        const messageStart = ensureMessageStart()
        if (messageStart) {
          yield messageStart
        }

        if (delta.reasoning_content) {
          reasoningValidationBuffer += delta.reasoning_content
          assertNoMalformedToolOutput(reasoningValidationBuffer, 'stream')
          const retainLength = getMalformedToolRetainLength(
            reasoningValidationBuffer,
          )
          reasoningValidationBuffer = reasoningValidationBuffer.slice(
            reasoningValidationBuffer.length - retainLength,
          )
          if (allowReasoning) {
            if (thinkingIndex === null) {
              thinkingIndex = nextIndex++
              yield {
                type: 'content_block_start',
                index: thinkingIndex,
                content_block: {
                  type: 'thinking',
                  thinking: '',
                  signature: '',
                },
              } as BetaRawMessageStreamEvent
            }
            yield {
              type: 'content_block_delta',
              index: thinkingIndex,
              delta: {
                type: 'thinking_delta',
                thinking: delta.reasoning_content,
              },
            } as BetaRawMessageStreamEvent
          }
        }

        if (delta.content) {
          const latestOpenTool = Array.from(openTools.values()).at(-1)
          if (latestOpenTool) {
            throw new Error(
              'Malformed streaming tool response leaked content after tool arguments',
            )
          }

          // Some OpenAI-compatible backends occasionally repeat the exact same
          // trailing content chunk back-to-back. Preserve normal repeated short
          // tokens, but drop large immediate duplicates that would otherwise
          // surface as obvious suffix echoes like `today?today?`.
          if (
            textValidationBuffer.length === 0 &&
            delta.content.length >= 4 &&
            delta.content === lastFlushedTextDelta
          ) {
            continue
          }

          textValidationBuffer += delta.content
          assertNoMalformedToolOutput(textValidationBuffer, 'stream')
          const retainLength = getMalformedToolRetainLength(textValidationBuffer)
          const flushableText = textValidationBuffer.slice(
            0,
            textValidationBuffer.length - retainLength,
          )
          if (flushableText) {
            const sanitizedFlushableText =
              stripVisibleReasoningMarkers(flushableText)
            if (sanitizedFlushableText) {
              yield* flushTextDelta(sanitizedFlushableText)
            } else {
              lastFlushedTextDelta = null
            }
          }
          textValidationBuffer = textValidationBuffer.slice(
            textValidationBuffer.length - retainLength,
          )
          if (!flushableText) {
            lastFlushedTextDelta = null
          }
        }

        for (const [position, toolCall] of (delta.tool_calls ?? []).entries()) {
          const toolKey = resolveToolKey(toolCall, position)
          const toolState = ensureToolState(toolKey, toolCall)
          const startEvent = emitToolStartIfReady(toolState)
          if (startEvent) {
            yield startEvent
          }
          if (toolCall.function?.arguments) {
            toolState.arguments = mergeToolArgumentChunk(
              toolState.arguments,
              toolCall.function.arguments,
            )
          }
        }
      }

      if (done) {
        break
      }
    }
  } catch (error) {
    if (streamController.signal.aborted) {
      return
    }
    throw error
  } finally {
    streamController.signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {}
  }

  if (!sawDoneSentinel && !sawFinishReason) {
    throw new Error('OpenAI-compatible stream ended before completion marker')
  }
  if (finalStopReason === null && sawDoneSentinel) {
    finalStopReason = openTools.size > 0 ? 'tool_use' : 'end_turn'
  }

  if (finalStopReason === 'tool_use' && openTools.size === 0) {
    throw new Error('Malformed streaming tool response missing tool_calls')
  }

  if (textValidationBuffer) {
    assertNoMalformedToolOutput(textValidationBuffer, 'stream')
    const sanitizedFinalText = stripVisibleReasoningMarkers(textValidationBuffer)
    if (sanitizedFinalText) {
      yield* flushTextDelta(sanitizedFinalText)
    }
  }

  if (!emittedMessageStart) {
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: messageModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: createBaseUsage(),
      },
    } as BetaRawMessageStreamEvent
  }

  if (thinkingIndex !== null) {
    const stopEvent = stopContentBlock(thinkingIndex)
    if (stopEvent) {
      yield stopEvent
    }
  }
  if (textIndex !== null) {
    const stopEvent = stopContentBlock(textIndex)
    if (stopEvent) {
      yield stopEvent
    }
  }
  for (const openTool of openTools.values()) {
    const startEvent = emitToolStartIfReady(openTool)
    if (startEvent) {
      yield startEvent
    }
    if (!openTool.started) {
      throw new Error('Malformed streaming tool response missing tool name')
    }
    if (openTool.arguments) {
      yield {
        type: 'content_block_delta',
        index: openTool.contentIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: openTool.arguments,
        },
      } as BetaRawMessageStreamEvent
    }
    const stopEvent = stopContentBlock(openTool.contentIndex)
    if (stopEvent) {
      yield stopEvent
    }
  }

  assertAssistantContentPresent('stream', finalStopReason, nextIndex)

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: finalStopReason,
      stop_sequence: finalStopSequence,
    },
    usage: finalUsage,
  } as BetaRawMessageStreamEvent

  yield {
    type: 'message_stop',
  } as BetaRawMessageStreamEvent
}

function createInferenceOperation<T>(
  responsePromise: Promise<Response>,
  parse: (response: Response) => Promise<T>,
): Promise<T> & {
  asResponse(): Promise<Response>
  withResponse(): Promise<{
    data: T
    response: Response
    request_id: string | null
  }>
} {
  const parsedPromise = responsePromise.then(parse)
  return Object.assign(parsedPromise, {
    asResponse: () => responsePromise,
    withResponse: async () => {
      const [data, response] = await Promise.all([parsedPromise, responsePromise])
      return {
        data,
        response,
        request_id: getRequestId(response),
      }
    },
  })
}

export class OpenAICompatInferenceClient implements InferenceClient {
  private readonly fetchImpl: FetchLike
  private readonly backendCapabilities: OpenAICompatBackendCapabilities

  constructor(private readonly options: OpenAICompatInferenceClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.backendCapabilities = resolveOpenAICompatBackendCapabilities(
      options.baseURL,
      options.backendCapabilities,
    )
  }

  private buildURL(path: string): string {
    return this.buildURLWithBase(path, this.options.baseURL)
  }

  private buildURLForModel(path: string, model: string): string {
    return this.buildURLWithBase(
      path,
      getNCodeManagedModelBaseUrl(model) ?? this.options.baseURL,
    )
  }

  private buildURLWithBase(path: string, baseURL: string): string {
    return new URL(
      path,
      baseURL.endsWith('/') ? baseURL : `${baseURL}/`,
    ).toString()
  }

  private async postJSON(
    path: string,
    body: unknown,
    init?: {
      signal?: AbortSignal
      headers?: HeadersInit
      model?: string
    },
  ): Promise<Response> {
    const headers = new Headers(this.options.headers)
    headers.set('content-type', 'application/json')
    headers.set('accept', 'application/json')
    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers.set(key, value)
    }
    const bodyModel =
      typeof body === 'object' &&
      body !== null &&
      'model' in body &&
      typeof body.model === 'string'
        ? body.model
        : undefined
    const routingHeaderModel = init?.model ?? bodyModel
    const routingModel = routingHeaderModel
      ? getNoumenaModelRoutingHeader(routingHeaderModel)
      : undefined
    if (routingModel) {
      headers.set('x-noumena-model', routingModel)
    }
    const url =
      routingHeaderModel
        ? this.buildURLForModel(path, routingHeaderModel)
        : this.buildURL(path)
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers,
        signal: init?.signal,
      })
    } catch (error) {
      if (init?.signal?.aborted || isAbortLike(error)) {
        throw error
      }
      throw new OpenAICompatTransportError(errorMessage(error), error)
    }
  }

  private buildHeaders(
    init?: { headers?: HeadersInit },
    accept = 'application/json',
    model?: string,
  ): Headers {
    const headers = new Headers(this.options.headers)
    headers.set('accept', accept)
    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers.set(key, value)
    }
    const routingModel = model ? getNoumenaModelRoutingHeader(model) : undefined
    if (routingModel) {
      headers.set('x-noumena-model', routingModel)
    }
    return headers
  }

  private getWsV2Transport(): OpenAICompatWsV2Transport | null {
    if (this.options.wsV2Transport !== undefined) {
      return this.options.wsV2Transport
    }
    return shouldUseOpenAICompatWsV2()
      ? createNativeOpenAICompatWsV2Transport()
      : null
  }

  private async getJSON(
    path: string,
    init?: {
      signal?: AbortSignal
      headers?: HeadersInit
    },
  ): Promise<Response> {
    const headers = new Headers(this.options.headers)
    headers.set('accept', 'application/json')
    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers.set(key, value)
    }
    try {
      return await this.fetchImpl(this.buildURL(path), {
        method: 'GET',
        headers,
        signal: init?.signal,
      })
    } catch (error) {
      if (init?.signal?.aborted || isAbortLike(error)) {
        throw error
      }
      throw new OpenAICompatTransportError(errorMessage(error), error)
    }
  }

  createMessage(
    ...args: InferenceCreateMessageArgs
  ): InferenceCreateMessageResult {
    const [params, requestOptions] = args
    const requestPolicy = resolveOpenAICompatRequestPolicy(
      params,
      this.backendCapabilities,
    )
    const request = buildOpenAICompatChatRequest(params, {
      policy: requestPolicy,
    })
    const apiModel = request.model
    const wsV2Transport = params.stream ? this.getWsV2Transport() : null
    const responsePromise = wsV2Transport
      ? wsV2Transport({
          url: this.buildURLForModel('/v1/chat/completions/ws/v2', params.model),
          headers: this.buildHeaders(requestOptions, 'application/json', params.model),
          request,
          signal: requestOptions?.signal,
        }).catch(error => {
          logForDebugging(
            `[OpenAICompatWsV2] falling back to SSE: ${errorMessage(error)}`,
            { level: 'warn' },
          )
          return this.postJSON('/v1/chat/completions', request, {
            signal: requestOptions?.signal,
            headers: requestOptions?.headers,
            model: params.model,
          })
        })
      : this.postJSON('/v1/chat/completions', request, {
          signal: requestOptions?.signal,
          headers: requestOptions?.headers,
          model: params.model,
        })

    const operation = createInferenceOperation(responsePromise, async response => {
      if (!response.ok) {
        throw new OpenAICompatHTTPError(response.status, response.statusText)
      }
      if (params.stream) {
        const controller = new AbortController()
        if (requestOptions?.signal) {
          if (requestOptions.signal.aborted) {
            controller.abort()
          } else {
            requestOptions.signal.addEventListener(
              'abort',
              () => controller.abort(),
              { once: true },
            )
          }
        }
        return new SDKStream(
          () =>
            streamOpenAIChatCompletionAsAnthropicEvents(
              response,
              params.model,
              controller,
              !requestPolicy.disableReasoning,
            ),
          controller,
        ) as Promise<unknown> as never
      }

      const responseBody =
        (await response.json()) as OpenAIChatCompletionResponse
      return mapOpenAIChatCompletionToAnthropicMessage(
        responseBody,
        response,
        params.model,
        { allowReasoning: !requestPolicy.disableReasoning },
      ) as Promise<unknown> as never
    })

    return operation as InferenceCreateMessageResult
  }

  countTokens(...args: InferenceCountTokensArgs): InferenceCountTokensResult {
    const [params] = args
    const operation = this.createMessage({
      model: params.model,
      max_tokens:
        params.thinking && typeof params.thinking === 'object' ? 32 : 1,
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.betas ? { betas: params.betas } : {}),
      ...(params.thinking ? { thinking: params.thinking } : {}),
      stream: false,
    } as InferenceCreateMessageArgs[0])

    return operation.then(message => ({
      input_tokens: message.usage.input_tokens,
    })) as InferenceCountTokensResult
  }

  listModels(...args: InferenceListModelsArgs): InferenceListModelsResult {
    const [, requestOptions] = args
    const responsePromise = this.getJSON('/v1/models', {
      signal: requestOptions?.signal,
      headers: requestOptions?.headers,
    })

    const iterable = {
      async *[Symbol.asyncIterator]() {
        const response = await responsePromise
        if (!response.ok) {
          throw new Error(
            `OpenAI compat models request failed: ${response.status} ${response.statusText}`,
          )
        }
        const body = (await response.json()) as OpenAIModelsResponse
        for (const entry of body.data ?? []) {
          yield entry
        }
      },
    }

    return iterable as InferenceListModelsResult
  }
}
