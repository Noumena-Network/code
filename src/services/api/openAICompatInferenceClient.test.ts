import { describe, expect, it } from 'bun:test'
import {
  buildOpenAICompatChatRequest,
  mapOpenAIChatCompletionToAnthropicMessage,
  OpenAICompatInferenceClient,
  OpenAICompatBackendAbortError,
  OpenAICompatMalformedToolOutputError,
  OpenAICompatTransportError,
  resolveOpenAICompatBackendCapabilities,
  resolveOpenAICompatRequestPolicy,
} from './openAICompatInferenceClient.js'
import {
  GLM_5_2_MODEL,
  KIMI_2_7_CODER_MODEL,
} from '../../utils/model/ncodeModels.js'

describe('buildOpenAICompatChatRequest', () => {
  it('preserves the caller-visible request information that maps to OpenAI compat', () => {
    const request = buildOpenAICompatChatRequest({
      model: 'tool-safe-openai-model',
      max_tokens: 2048,
      system: [{ type: 'text', text: 'system prompt' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal reasoning', signature: '' },
            { type: 'text', text: 'partial answer' },
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Bash',
              input: { cmd: 'pwd' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'ok',
            },
            { type: 'text', text: 'continue' },
          ],
        },
      ],
      tools: [
        {
          name: 'Bash',
          description: 'Run shell commands',
          input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      ],
      tool_choice: { type: 'tool', name: 'Bash' },
      output_config: {
        format: {
          type: 'json_schema',
          name: 'Answer',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
          strict: true,
        },
      },
      stop_sequences: ['STOP'],
      temperature: 0.2,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      betas: ['beta-a', 'beta-b'],
      metadata: { source: 'test' },
      context_management: { clear_function_results: true },
      speed: 'fast',
      stream: true,
    } as never)

    expect(request).toMatchObject({
      model: 'tool-safe-openai-model',
      max_tokens: 2048,
      max_completion_tokens: 2048,
      stop: ['STOP'],
      temperature: 0.2,
      stream: true,
      stream_options: {
        include_usage: true,
        continuous_usage_stats: false,
      },
      separate_reasoning: true,
      stream_reasoning: true,
      reasoning_effort: 'high',
      chat_template_kwargs: {
        thinking: true,
        enable_thinking: true,
      },
      tool_choice: {
        type: 'function',
        function: { name: 'Bash' },
      },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'Answer',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
          },
          strict: true,
        },
      },
      custom_params: {
        noumena_requested_betas: ['beta-a', 'beta-b'],
        noumena_metadata: { source: 'test' },
        noumena_context_management: { clear_function_results: true },
        noumena_speed: 'fast',
        noumena_original_thinking: { type: 'enabled', budget_tokens: 1024 },
      },
    })

    expect(request.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'partial answer',
        reasoning_content: 'internal reasoning',
        tool_calls: [
          {
            id: 'tool_1',
            type: 'function',
            function: {
              name: 'Bash',
              arguments: '{"cmd":"pwd"}',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tool_1', content: 'ok' },
      { role: 'user', content: 'continue' },
    ])

    expect(request.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'Bash',
          description: 'Run shell commands',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
          },
        },
      },
    ])
  })

  it('maps disabled thinking to a no-reasoning request', () => {
    const request = buildOpenAICompatChatRequest({
      model: 'kimi-k2.5',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'disabled' },
    } as never)

    expect(request.reasoning_effort).toBe('none')
    expect(request.separate_reasoning).toBeUndefined()
    expect(request.stream_reasoning).toBeUndefined()
    expect(request.chat_template_kwargs).toEqual({
      thinking: false,
      enable_thinking: false,
    })
  })

  it('maps NCode effort levels onto OpenAI-compatible reasoning effort per request', () => {
    for (const effort of ['medium', 'high', 'max'] as const) {
      const request = buildOpenAICompatChatRequest({
        model: '/data/models/hf/deepseek-ai__DeepSeek-V4-Pro',
        max_tokens: 64,
        messages: [{ role: 'user', content: `effort ${effort}` }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
        output_config: { effort },
      } as never)

      expect(request.reasoning_effort).toBe(effort)
      expect(request.separate_reasoning).toBe(true)
      expect(request.stream_reasoning).toBe(true)
      expect(request.chat_template_kwargs).toEqual({
        thinking: true,
        enable_thinking: true,
      })
      expect(request.custom_params).toMatchObject({
        noumena_original_output_config: { effort },
      })
    }
  })

  it('lets explicit thinking-off override any requested effort level', () => {
    const request = buildOpenAICompatChatRequest({
      model: '/data/models/hf/deepseek-ai__DeepSeek-V4-Pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'max' },
    } as never)

    expect(request.reasoning_effort).toBe('none')
    expect(request.separate_reasoning).toBeUndefined()
    expect(request.stream_reasoning).toBeUndefined()
    expect(request.chat_template_kwargs).toEqual({
      thinking: false,
      enable_thinking: false,
    })
  })

  it('uses auto tool choice for OpenAI-compatible tool-capable requests', () => {
    const params = {
      model: '/data/models/hf/deepseek-ai__DeepSeek-V4-Pro',
      max_tokens: 64,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
            },
            required: ['file_path'],
          },
        },
      ],
    } as never

    const policy = resolveOpenAICompatRequestPolicy(params, {
      reasoningTransport: 'separate_reasoning',
    })
    const request = buildOpenAICompatChatRequest(params, { policy })

    expect(policy).toEqual({ disableReasoning: false })
    expect(request.reasoning_effort).toBe('high')
    expect(request.tool_choice).toBe('auto')
    expect(request.separate_reasoning).toBe(true)
    expect(request.stream_reasoning).toBe(true)
    expect(request.chat_template_kwargs).toEqual({
      thinking: true,
      enable_thinking: true,
    })
  })

  it('maps Anthropic any tool choice to OpenAI required tool choice', () => {
    const request = buildOpenAICompatChatRequest({
      model: '/data/models/hf/deepseek-ai__DeepSeek-V4-Pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: { type: 'any' },
      tools: [
        {
          name: 'Bash',
          description: 'Run a command',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
            required: ['command'],
          },
        },
      ],
    } as never)

    expect(request.tool_choice).toBe('required')
  })

  it('keeps reasoning enabled for tool-result continuations on safe backends', () => {
    const params = {
      model: 'kimi-k2.5',
      max_tokens: 64,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Bash',
              input: { command: 'printf pong' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: 'pong',
            },
          ],
        },
      ],
    } as never

    const policy = resolveOpenAICompatRequestPolicy(params, {
      reasoningTransport: 'separate_reasoning',
    })
    const request = buildOpenAICompatChatRequest(params, { policy })

    expect(policy).toEqual({ disableReasoning: false })
    expect(request.reasoning_effort).toBe('high')
    expect(request.chat_template_kwargs).toEqual({
      thinking: true,
      enable_thinking: true,
    })
    expect(request.custom_params).toMatchObject({
      noumena_original_thinking: { type: 'enabled', budget_tokens: 1024 },
    })
  })

  it('disables reasoning for backends that cannot separate reasoning transport', () => {
    const capabilities = resolveOpenAICompatBackendCapabilities(
      'https://explicit-transport.example.com',
      { reasoningTransport: 'unsafe_visible_content' },
    )
    const policy = resolveOpenAICompatRequestPolicy(
      {
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        max_tokens: 64,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'hello' }],
      } as never,
      capabilities,
    )

    expect(capabilities).toEqual({
      reasoningTransport: 'unsafe_visible_content',
    })
    expect(policy).toEqual({ disableReasoning: true })

    const request = buildOpenAICompatChatRequest(
      {
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        max_tokens: 64,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'hello' }],
      } as never,
      { policy },
    )

    expect(request.reasoning_effort).toBe('none')
    expect(request.chat_template_kwargs).toEqual({
      thinking: false,
      enable_thinking: false,
    })
    expect(request.custom_params).toMatchObject({
      noumena_original_thinking: { type: 'enabled', budget_tokens: 1024 },
    })
  })

  it('keeps reasoning enabled for Kimi models on safe backends', () => {
    const policy = resolveOpenAICompatRequestPolicy(
      {
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        max_tokens: 64,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'hello' }],
      } as never,
      { reasoningTransport: 'separate_reasoning' },
    )

    expect(policy).toEqual({ disableReasoning: false })

    const request = buildOpenAICompatChatRequest(
      {
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        max_tokens: 64,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'hello' }],
      } as never,
      { policy },
    )

    expect(request.reasoning_effort).toBe('high')
    expect(request.chat_template_kwargs).toEqual({
      thinking: true,
      enable_thinking: true,
    })
  })

  it('allows a global reasoning transport override for proxied backends', () => {
    const originalTransport = process.env.NOUMENA_OPENAI_COMPAT_REASONING_TRANSPORT

    try {
      process.env.NOUMENA_OPENAI_COMPAT_REASONING_TRANSPORT =
        'unsafe_visible_content'
      expect(
        resolveOpenAICompatBackendCapabilities('http://127.0.0.1:54375'),
      ).toEqual({
        reasoningTransport: 'unsafe_visible_content',
      })
    } finally {
      if (originalTransport === undefined) {
        delete process.env.NOUMENA_OPENAI_COMPAT_REASONING_TRANSPORT
      } else {
        process.env.NOUMENA_OPENAI_COMPAT_REASONING_TRANSPORT =
          originalTransport
      }
    }
  })

  it('emits assistant tool-call turns with content null', () => {
    const request = buildOpenAICompatChatRequest({
      model: 'kimi-k2.5',
      max_tokens: 64,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'ReturnAnswer',
              input: { answer: 'pong' },
            },
          ],
        },
      ],
    } as never)

    expect(request.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tool_1',
            type: 'function',
            function: {
              name: 'ReturnAnswer',
              arguments: '{"answer":"pong"}',
            },
          },
        ],
      },
    ])
  })
})

describe('mapOpenAIChatCompletionToAnthropicMessage', () => {
  it('preserves content, tool calls, usage, stop reason, and request ID', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-123' },
    })

    const message = mapOpenAIChatCompletionToAnthropicMessage(
      {
        id: 'chatcmpl-1',
        model: 'kimi-k2.5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'final answer',
              reasoning_content: 'hidden reasoning',
              tool_calls: [
                {
                  id: 'tool_1',
                  function: {
                    name: 'Bash',
                    arguments: '{"cmd":"pwd"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 9,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
      response,
      'fallback-model',
    )

    expect(message).toMatchObject({
      id: 'chatcmpl-1',
      model: 'kimi-k2.5',
      stop_reason: 'tool_use',
      _request_id: 'req-123',
      usage: {
        input_tokens: 21,
        output_tokens: 9,
        cache_read_input_tokens: 4,
      },
      content: [
        { type: 'thinking', thinking: 'hidden reasoning', signature: '' },
        { type: 'text', text: 'final answer' },
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'Bash',
          input: { cmd: 'pwd' },
        },
      ],
    })
  })

  it('normalizes non-string matched_stop values to a null stop_sequence', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-456' },
    })

    const message = mapOpenAIChatCompletionToAnthropicMessage(
      {
        id: 'chatcmpl-2',
        model: 'kimi-k2.5',
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'tool_1',
                  function: {
                    name: 'ReturnAnswer',
                    arguments: '{"answer":"pong"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
            matched_stop: 163586,
          },
        ],
      },
      response,
      'fallback-model',
    )

    expect(message.stop_reason).toBe('tool_use')
    expect(message.stop_sequence).toBeNull()
  })

  it('fails unary responses that leak bare pseudo-tool call text', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-pseudo' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-pseudo',
          model: 'kimi-k2.5',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'Let me do that.functions.Bash:0{"command":"printf pong"}',
              },
              finish_reason: 'stop',
              matched_stop: 163586,
            },
          ],
        },
        response,
        'fallback-model',
      ),
    ).toThrow('Malformed unary tool output leaked from backend response')
  })

  it('classifies unary pseudo-tool text as a model protocol error', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-pseudo-typed' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-pseudo-typed',
          model: 'kimi-k2.5',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Action: Bash\nAction Input: {"command":"pwd"}',
              },
              finish_reason: 'stop',
            },
          ],
        },
        response,
        'fallback-model',
      ),
    ).toThrow(OpenAICompatMalformedToolOutputError)
  })

  it('fails unary responses that leak wrapped pseudo-tool call text', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-pseudo-wrapped' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-pseudo-wrapped',
          model: 'kimi-k2.5',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'Let me do that.<|tool_calls_section_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"file_path":"/etc/hosts"}<|tool_call_end|><|tool_calls_section_end|>',
              },
              finish_reason: 'stop',
              matched_stop: 163586,
            },
          ],
        },
        response,
        'fallback-model',
      ),
    ).toThrow('Malformed unary tool output leaked from backend response')
  })

  it('fails unary responses that leak ReAct-style pseudo-tool text', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-react-pseudo-tool' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-react-pseudo-tool',
          model: 'dsv4-pro',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'I will inspect the repo.\nAction: list_files\nAction Input: {"target_directory":"/repo","depth":2}',
              },
              finish_reason: 'stop',
            },
          ],
        },
        response,
        'fallback-model',
      ),
    ).toThrow('Malformed unary tool output leaked from backend response')
  })

  it('fails unary responses that leak XML pseudo-tool request text', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-xml-pseudo-tool' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-xml-pseudo-tool',
          model: 'dsv4-pro',
          choices: [
            {
              message: {
                role: 'assistant',
                content: "I'll inspect it.\n<request>xml\n</request>",
              },
              finish_reason: 'stop',
            },
          ],
        },
        response,
        'fallback-model',
      ),
    ).toThrow('Malformed unary tool output leaked from backend response')
  })

  it('fails unary reasoning that leaks pseudo-tool request text', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-reasoning-pseudo-tool' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-reasoning-pseudo-tool',
          model: 'dsv4-pro',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                reasoning_content:
                  'I should call a tool.\n[calling list_files] {"target_directory":"/repo"}\nAction: list_files',
              },
              finish_reason: 'stop',
            },
          ],
        },
        response,
        'fallback-model',
      ),
    ).toThrow('Malformed unary tool output leaked from backend response')
  })

  it('fails unary responses that leak DSML pseudo-tool request text', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-dsml-pseudo-tool' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-dsml-pseudo-tool',
          model: 'dsv4-pro',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  '<｜DSML｜tool_calls>\n<invoke>\n<tool_name>list_files>\n</invoke>\n</tool_calls>',
              },
              finish_reason: 'stop',
            },
          ],
        },
        response,
        'fallback-model',
      ),
    ).toThrow('Malformed unary tool output leaked from backend response')
  })

  it('fails unary responses that leak visible protocol tags', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-visible-protocol-tags' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-visible-protocol-tags',
          model: 'dsv4-pro',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  '<analysis>Inspect repo</analysis>\n< observation>Wrong repo</observation>\n<error_feedback>Need more info</error>\n<attempt_completion>Ask user</attempt_completion>',
              },
              finish_reason: 'stop',
            },
          ],
        },
        response,
        'fallback-model',
      ),
    ).toThrow('Malformed unary tool output leaked from backend response')
  })

  it('strips unary visible think markers from assistant text', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-think-marker-unary' },
    })

    const message = mapOpenAIChatCompletionToAnthropicMessage(
      {
        id: 'chatcmpl-think-marker-unary',
        model: 'kimi-k2.5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Let me check that.</think>## Findings',
            },
            finish_reason: 'stop',
            matched_stop: 163586,
          },
        ],
      },
      response,
      'fallback-model',
    )

    expect(message.content).toContainEqual({
      type: 'text',
      text: 'Let me check that.## Findings',
    })
  })

  it('fails unary tool responses that claim tool_use without tool_calls', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-missing-tool-calls' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-missing-tool-calls',
          model: 'kimi-k2.5',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        response,
        'fallback-model',
      ),
    ).toThrow('Malformed unary tool response missing tool_calls')
  })

  it('fails unary responses that stop without assistant content', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-empty-stop' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-empty-stop',
          model: 'kimi-k2.5',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 0,
            total_tokens: 12,
          },
        } as never,
        response,
        'fallback-model',
      ),
    ).toThrow('Malformed unary response missing assistant content')
  })

  it('treats unary backend aborts as retryable connection errors', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-abort-unary' },
    })

    expect(() =>
      mapOpenAIChatCompletionToAnthropicMessage(
        {
          id: 'chatcmpl-abort-unary',
          model: 'dsv4-pro',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
              },
              finish_reason: 'abort',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 0,
            total_tokens: 12,
          },
        } as never,
        response,
        'fallback-model',
      ),
    ).toThrow(OpenAICompatBackendAbortError)
  })

  it('drops unary reasoning blocks when the final request policy disabled reasoning', () => {
    const response = new Response('{}', {
      headers: { 'request-id': 'req-disabled-reasoning' },
    })

    const message = mapOpenAIChatCompletionToAnthropicMessage(
      {
        id: 'chatcmpl-disabled',
        model: 'kimi-k2.5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'final answer',
              reasoning_content: 'hidden reasoning',
            },
            finish_reason: 'stop',
          },
        ],
      },
      response,
      'fallback-model',
      { allowReasoning: false },
    )

    expect(message.content).toEqual([{ type: 'text', text: 'final answer' }])
  })
})

describe('OpenAICompatInferenceClient', () => {
  it('streams OpenAI chat chunks as Anthropic-style events with raw headers preserved', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-1',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: 'think' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-1',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { content: 'hello' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-1',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'tool_1',
                  function: { name: 'Bash', arguments: '{"cmd":"p' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-1',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'wd"}' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-1',
        model: 'kimi-k2.5',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      sseData({
        id: 'chatcmpl-1',
        model: 'kimi-k2.5',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-stream' },
        }),
    })

    const operation = client.createMessage({
      model: 'kimi-k2.5',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    expect(withResponse.request_id).toBe('req-stream')
    expect(withResponse.response.headers.get('request-id')).toBe('req-stream')
    expect(withResponse.data).toHaveProperty('controller')
    expect(
      (withResponse.data as AsyncIterable<Record<string, unknown>> & {
        controller: AbortController
      }).controller,
    ).toBeInstanceOf(AbortController)

    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    expect(seen).toEqual([
      {
        type: 'message_start',
        message: {
          id: 'chatcmpl-1',
          type: 'message',
          role: 'assistant',
          model: 'kimi-k2.5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
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
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'think' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'hello' },
      },
      {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          id: 'tool_1',
          name: 'Bash',
          input: '',
        },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'content_block_stop',
        index: 1,
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"cmd":"pwd"}' },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 2,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: null,
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 0,
          },
          inference_geo: null,
          iterations: null,
          speed: null,
        },
      },
      { type: 'message_stop' },
    ])
  })

  it('normalizes GLM streamed tool argument snapshots into one valid JSON delta', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const finalArguments =
      '{"command":"find /mlstore/src/noumena/ncode/api -maxdepth 2 -type f | sort","description":"List api crate files"}'
    const events = [
      sseData({
        id: 'chatcmpl-glm-tool',
        model: GLM_5_2_MODEL,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }),
      sseData({
        id: 'chatcmpl-glm-tool',
        model: GLM_5_2_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_glm',
                  type: 'function',
                  function: { name: 'Bash' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-glm-tool',
        model: GLM_5_2_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments:
                      '{"command":"find /mlstore/src/noumena/ncode/api -maxdepth 2 -type f | sort"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-glm-tool',
        model: GLM_5_2_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: '"description":"List api crate files"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-glm-tool',
        model: GLM_5_2_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: finalArguments },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-glm-tool',
        model: GLM_5_2_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () => new Response(stream),
    })

    const operation = client.createMessage({
      model: GLM_5_2_MODEL,
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'review api' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    const argumentDeltas = seen.filter(
      event =>
        event.type === 'content_block_delta' &&
        (event.delta as { type?: string } | undefined)?.type === 'input_json_delta',
    )

    expect(argumentDeltas).toEqual([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: finalArguments },
      },
    ])
  })

  it('keeps parallel streamed tool calls separate when backend omits tool indexes', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-glm-parallel-tools',
        model: GLM_5_2_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: 'call_bash',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '{"command":"pwd"}',
                  },
                },
                {
                  id: 'call_read',
                  type: 'function',
                  function: {
                    name: 'Read',
                    arguments: '{"file_path":"/tmp/example"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-glm-parallel-tools',
        model: GLM_5_2_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () => new Response(stream),
    })

    const operation = client.createMessage({
      model: GLM_5_2_MODEL,
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'run parallel tools' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    expect(
      seen.filter(event => event.type === 'content_block_start'),
    ).toEqual([
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_bash',
          name: 'Bash',
          input: '',
        },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'call_read',
          name: 'Read',
          input: '',
        },
      },
    ])
    expect(
      seen.filter(
        event =>
          event.type === 'content_block_delta' &&
          (event.delta as { type?: string } | undefined)?.type === 'input_json_delta',
      ),
    ).toEqual([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"file_path":"/tmp/example"}',
        },
      },
    ])
  })

  it('defers streamed tool block start until a late tool name arrives', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-glm-late-name',
        model: GLM_5_2_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: 'call_late',
                  type: 'function',
                  function: { arguments: '{"command":"pwd"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-glm-late-name',
        model: GLM_5_2_MODEL,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  id: 'call_late',
                  type: 'function',
                  function: { name: 'Bash' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-glm-late-name',
        model: GLM_5_2_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () => new Response(stream),
    })

    const operation = client.createMessage({
      model: GLM_5_2_MODEL,
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'late name' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    expect(
      seen.filter(event => event.type === 'content_block_start'),
    ).toEqual([
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_late',
          name: 'Bash',
          input: '',
        },
      },
    ])
    expect(
      seen.filter(
        event =>
          event.type === 'content_block_delta' &&
          (event.delta as { type?: string } | undefined)?.type === 'input_json_delta',
      ),
    ).toEqual([
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
      },
    ])
  })

  it('fails streamed tool responses that leak content after tool arguments', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-spillover',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-spillover',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'functions.functions.Read:0',
                  function: {
                    name: 'functions.Read',
                    arguments: '{"file_path":"/etc/',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-spillover',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { content: 'hosts"}' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-spillover',
        model: 'kimi-k2.5',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-stream-spillover' },
        }),
    })

    const operation = client.createMessage({
      model: 'kimi-k2.5',
      stream: true,
      max_tokens: 64,
      tools: [
        {
          name: 'functions.Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
            },
            required: ['file_path'],
          },
        },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()

    await expect(
      (async () => {
        for await (const _event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
          // Iterate until the malformed backend event is observed.
        }
      })(),
    ).rejects.toThrow(
      'Malformed streaming tool response leaked content after tool arguments',
    )
  })

  it('fails truncated streams that end before a completion marker', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-truncated',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'partial' },
            finish_reason: null,
          },
        ],
      }),
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-truncated-stream' },
        }),
    })

    const operation = client.createMessage({
      model: 'kimi-k2.5',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    await expect(
      (async () => {
        for await (const _event of withResponse.data as AsyncIterable<
          Record<string, unknown>
        >) {
        }
      })(),
    ).rejects.toThrow('OpenAI-compatible stream ended before completion marker')
  })

  it('fails streamed responses that stop without assistant content', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-empty-stop',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: null },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-empty-stop',
        model: 'kimi-k2.5',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-empty-stop-stream' },
        }),
    })

    const operation = client.createMessage({
      model: 'kimi-k2.5',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    await expect(
      (async () => {
        for await (const _event of withResponse.data as AsyncIterable<
          Record<string, unknown>
        >) {
        }
      })(),
    ).rejects.toThrow('Malformed stream response missing assistant content')
  })

  it('treats streamed backend aborts as retryable connection errors', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-abort-stream',
        model: 'dsv4-pro',
        choices: [
          {
            index: 0,
            delta: { reasoning_content: null },
            finish_reason: 'abort',
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-abort-stream',
        model: 'dsv4-pro',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 0,
          total_tokens: 12,
        },
      }),
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-abort-stream' },
        }),
    })

    const operation = client.createMessage({
      model: 'dsv4-pro',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    await expect(
      (async () => {
        for await (const _event of withResponse.data as AsyncIterable<
          Record<string, unknown>
        >) {
        }
      })(),
    ).rejects.toThrow(OpenAICompatBackendAbortError)
  })

  it('supports non-streaming createMessage, countTokens, and listModels', async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init })
        if (String(input).endsWith('/v1/models')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'model-a', object: 'model' },
                { id: 'model-b', object: 'model' },
              ],
            }),
          )
        }

        return new Response(
          JSON.stringify({
            id: 'chatcmpl-2',
            model: 'kimi-k2.5',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'pong',
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 1,
            },
          }),
          { headers: { 'request-id': 'req-unary' } },
        )
      },
    })

    const message = await client.createMessage({
      model: 'kimi-k2.5',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with exactly pong.' }],
    } as never)

    expect(message).toMatchObject({
      stop_reason: 'end_turn',
      _request_id: 'req-unary',
      usage: {
        input_tokens: 8,
        output_tokens: 1,
      },
      content: [{ type: 'text', text: 'pong' }],
    })

    const tokenCount = await client.countTokens({
      model: 'kimi-k2.5',
      messages: [{ role: 'user', content: 'count' }],
    } as never)
    expect(tokenCount).toEqual({ input_tokens: 8 })

    const listed: Array<Record<string, unknown>> = []
    for await (const entry of client.listModels({ betas: ['beta-a'] } as never) as AsyncIterable<Record<string, unknown>>) {
      listed.push(entry)
    }
    expect(listed).toEqual([
      { id: 'model-a', object: 'model' },
      { id: 'model-b', object: 'model' },
    ])

    expect(fetchCalls.map(call => call.url)).toEqual([
      'http://example.test/v1/chat/completions',
      'http://example.test/v1/chat/completions',
      'http://example.test/v1/models',
    ])
  })

  it('routes chat completions by the actual request model, not the stale client model', async () => {
    const fetchCalls: Array<string> = []
    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://95.133.253.252',
      fetch: async (input, _init) => {
        fetchCalls.push(String(input))
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-route',
            model: '/data/models/hf/moonshotai__Kimi-K2.6',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'routed',
                },
                finish_reason: 'stop',
              },
            ],
          }),
        )
      },
    })

    await client.createMessage({
      model: '/data/models/hf/moonshotai__Kimi-K2.6',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'route' }],
    } as never)

    expect(fetchCalls).toEqual([
      'http://95.133.253.252/v1/chat/completions',
    ])
  })

  it('normalizes NCode managed model aliases before sending OpenAI-compatible HTTP requests', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const headers: Headers[] = []
    const client = new OpenAICompatInferenceClient({
      baseURL: 'https://api.noumena.com',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        headers.push(new Headers(init?.headers))
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-kimi27',
            model: String(bodies.at(-1)?.model ?? KIMI_2_7_CODER_MODEL),
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'ok',
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 1,
            },
          }),
        )
      },
    })

    await client.createMessage({
      model: 'Kimi 2.7 Coder',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    await client.createMessage({
      model: 'glm-5.2',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    expect(bodies[0]?.model).toBe(KIMI_2_7_CODER_MODEL)
    expect(headers[0]?.get('x-noumena-model')).toBe('kimi-k25')
    expect(bodies[1]?.model).toBe(GLM_5_2_MODEL)
    expect(headers[1]?.get('x-noumena-model')).toBe('glm52')
  })

  it('makes streamed unsafe-backend requests honor the final reasoning policy instead of the raw caller toggle', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-kimi',
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                'The user said hi. I should answer briefly.Mode: No-Edits\n\nHi!',
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-kimi',
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      sseData({
        id: 'chatcmpl-kimi',
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
        },
      }),
      'data: [DONE]\n\n',
    ]

    const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL:
        'https://kimi-k25-sglang-gateway.noumena-onecc-mk8s01.clusters.gpus.com',
      backendCapabilities: { reasoningTransport: 'unsafe_visible_content' },
      fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), init })
        return new Response(stream, {
          headers: { 'request-id': 'req-kimi-stream' },
        })
      },
    })

    const operation = client.createMessage({
      model: '/data/models/hf/moonshotai__Kimi-K2.5',
      stream: true,
      max_tokens: 64,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    const body = JSON.parse(String(fetchCalls[0]?.init?.body))
    expect(body.reasoning_effort).toBe('none')
    expect(body.separate_reasoning).toBeUndefined()
    expect(body.stream_reasoning).toBeUndefined()
    expect(body.chat_template_kwargs).toEqual({
      thinking: false,
      enable_thinking: false,
    })
    expect(seen).not.toContainEqual(
      expect.objectContaining({
        type: 'content_block_start',
        content_block: expect.objectContaining({ type: 'thinking' }),
      }),
    )
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: expect.objectContaining({
          type: 'text_delta',
          text:
            'The user said hi. I should answer briefly.Mode: No-Edits\n\nHi!',
        }),
      }),
    )
  })

  it('drops streamed explicit reasoning deltas when backend policy disabled reasoning', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-disabled-stream',
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: 'hidden reasoning' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-disabled-stream',
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        choices: [
          {
            index: 0,
            delta: { content: 'Hello there!' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-disabled-stream',
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      sseData({
        id: 'chatcmpl-disabled-stream',
        model: '/data/models/hf/moonshotai__Kimi-K2.5',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
        },
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL:
        'https://kimi-k25-sglang-gateway.noumena-onecc-mk8s01.clusters.gpus.com',
      backendCapabilities: { reasoningTransport: 'unsafe_visible_content' },
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-disabled-stream' },
        }),
    })

    const operation = client.createMessage({
      model: '/data/models/hf/moonshotai__Kimi-K2.5',
      stream: true,
      max_tokens: 64,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    expect(seen).not.toContainEqual(
      expect.objectContaining({
        type: 'content_block_start',
        content_block: expect.objectContaining({ type: 'thinking' }),
      }),
    )
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: expect.objectContaining({
          type: 'text_delta',
          text: 'Hello there!',
        }),
      }),
    )
  })

  it('strips streamed visible think markers even when split across chunks', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-think-marker-stream',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Let me check that.' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-think-marker-stream',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [
          {
            index: 0,
            delta: { content: '</th' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-think-marker-stream',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [
          {
            index: 0,
            delta: { content: 'ink>## Findings' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-think-marker-stream',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      sseData({
        id: 'chatcmpl-think-marker-stream',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
        },
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-think-marker-stream' },
        }),
    })

    const operation = client.createMessage({
      model: '/data/models/hf/moonshotai__Kimi-K2.6',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    expect(seen).not.toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: expect.objectContaining({
          type: 'text_delta',
          text: expect.stringContaining('</think>'),
        }),
      }),
    )
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: expect.objectContaining({
          type: 'text_delta',
          text: '## Findings',
        }),
      }),
    )
  })

  it('deduplicates repeated immediate trailing text chunks from buggy backends', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-dup-tail',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-dup-tail',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [
          {
            index: 0,
            delta: { content: 'How can I help you ' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-dup-tail',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [
          {
            index: 0,
            delta: { content: 'today?' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-dup-tail',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [
          {
            index: 0,
            delta: { content: 'today?' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-dup-tail',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      sseData({
        id: 'chatcmpl-dup-tail',
        model: '/data/models/hf/moonshotai__Kimi-K2.6',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
        },
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-dup-tail' },
        }),
    })

    const operation = client.createMessage({
      model: '/data/models/hf/moonshotai__Kimi-K2.6',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    const textDeltas = seen
      .filter(
        event =>
          event.type === 'content_block_delta' &&
          typeof event.delta === 'object' &&
          event.delta !== null &&
          'type' in event.delta &&
          event.delta.type === 'text_delta',
      )
      .map(event => (event.delta as { text: string }).text)

    expect(textDeltas).toEqual(['How can I help you ', 'today?'])
  })

  it('fails streamed responses that leak bare tool marker text', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-pseudo',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Let me do that.' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-pseudo',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { content: 'functions.Bash:0{"command":"printf pong"}' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-pseudo',
        model: 'kimi-k2.5',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      sseData({
        id: 'chatcmpl-pseudo',
        model: 'kimi-k2.5',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
        },
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-pseudo-stream' },
        }),
    })

    const operation = client.createMessage({
      model: 'kimi-k2.5',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()

    await expect(
      (async () => {
        for await (const _event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
          // Iterate until the malformed backend event is observed.
        }
      })(),
    ).rejects.toThrow('Malformed stream tool output leaked from backend response')
  })

  it('fails streamed responses that leak wrapped tool marker text', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-pseudo-wrapped',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: 'Let me do that.',
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-pseudo-wrapped',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: {
              content:
                '<|tool_calls_section_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"file_path":"/etc/hosts"}<|tool_call_end|><|tool_calls_section_end|>',
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-pseudo-wrapped',
        model: 'kimi-k2.5',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      sseData({
        id: 'chatcmpl-pseudo-wrapped',
        model: 'kimi-k2.5',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
        },
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-pseudo-wrapped-stream' },
        }),
    })

    const operation = client.createMessage({
      model: 'kimi-k2.5',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()

    await expect(
      (async () => {
        for await (const _event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
          // Iterate until the malformed backend event is observed.
        }
      })(),
    ).rejects.toThrow('Malformed stream tool output leaked from backend response')
  })

  it('fails streamed responses that leak wrapped tool markers across split content chunks', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-pseudo-wrapped-split',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: '',
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-pseudo-wrapped-split',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { content: '<|tool_calls_section_b' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-pseudo-wrapped-split',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { content: 'egin|><|tool_call_b' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-pseudo-wrapped-split',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: { content: 'egin|>functions.Read:0<|tool_call_argument_b' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-pseudo-wrapped-split',
        model: 'kimi-k2.5',
        choices: [
          {
            index: 0,
            delta: {
              content:
                'egin|>{"file_path":"/etc/hosts"}<|tool_call_end|><|tool_calls_section_end|>',
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-pseudo-wrapped-split',
        model: 'kimi-k2.5',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-pseudo-wrapped-split-stream' },
        }),
    })

    const operation = client.createMessage({
      model: 'kimi-k2.5',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []

    await expect(
      (async () => {
        for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
          seen.push(event)
        }
      })(),
    ).rejects.toThrow('Malformed stream tool output leaked from backend response')

    expect(seen).not.toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: expect.objectContaining({
          type: 'text_delta',
        }),
      }),
    )
  })

  it('fails streamed responses that leak split ReAct-style pseudo-tool text', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-react-pseudo-stream',
        model: 'dsv4-pro',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: 'I will inspect.',
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-react-pseudo-stream',
        model: 'dsv4-pro',
        choices: [
          {
            index: 0,
            delta: { content: '\nAct' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-react-pseudo-stream',
        model: 'dsv4-pro',
        choices: [
          {
            index: 0,
            delta: {
              content:
                'ion: list_files\nAction Input: {"target_directory":"/repo"}',
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-react-pseudo-stream',
        model: 'dsv4-pro',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-react-pseudo-stream' },
        }),
    })

    const operation = client.createMessage({
      model: 'dsv4-pro',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()

    await expect(
      (async () => {
        for await (const _event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
          // Iterate until the malformed backend event is observed.
        }
      })(),
    ).rejects.toThrow('Malformed stream tool output leaked from backend response')
  })

  it('fails streamed reasoning that leaks split pseudo-tool text', async () => {
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const events = [
      sseData({
        id: 'chatcmpl-reasoning-pseudo-stream',
        model: 'dsv4-pro',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              reasoning_content: 'I should call ',
            },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-reasoning-pseudo-stream',
        model: 'dsv4-pro',
        choices: [
          {
            index: 0,
            delta: { reasoning_content: 'Act' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-reasoning-pseudo-stream',
        model: 'dsv4-pro',
        choices: [
          {
            index: 0,
            delta: { reasoning_content: 'ion: list_files' },
            finish_reason: null,
          },
        ],
      }),
      sseData({
        id: 'chatcmpl-reasoning-pseudo-stream',
        model: 'dsv4-pro',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      'data: [DONE]\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-reasoning-pseudo-stream' },
        }),
    })

    const operation = client.createMessage({
      model: 'dsv4-pro',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()

    await expect(
      (async () => {
        for await (const _event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
          // Iterate until the malformed backend event is observed.
        }
      })(),
    ).rejects.toThrow('Malformed stream tool output leaked from backend response')
  })

  it('uses injected WS v2 transport for streamed OpenAI-compatible requests', async () => {
    const fetchCalls: Array<string> = []
    const wsCalls: Array<{ url: string; request: Record<string, unknown>; headers: Headers }> = []
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const stream = new ReadableStream({
      start(controller) {
        for (const event of [
          sseData({
            id: 'chatcmpl-ws2',
            model: 'test-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
          }),
          sseData({
            id: 'chatcmpl-ws2',
            model: 'test-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }),
          sseData({
            id: 'chatcmpl-ws2',
            model: 'test-model',
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }),
          'data: [DONE]\n\n',
        ]) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      headers: { authorization: 'Bearer token' },
      fetch: async input => {
        fetchCalls.push(String(input))
        throw new Error('fetch should not be used for injected WS v2 stream')
      },
      wsV2Transport: async args => {
        wsCalls.push({
          url: args.url,
          request: args.request as Record<string, unknown>,
          headers: args.headers,
        })
        return new Response(stream, { headers: { 'request-id': 'req-ws2' } })
      },
    })

    const operation = client.createMessage({
      model: 'test-model',
      stream: true,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    expect(fetchCalls).toEqual([])
    expect(wsCalls).toHaveLength(1)
    expect(wsCalls[0]?.url).toBe('http://example.test/v1/chat/completions/ws/v2')
    expect(wsCalls[0]?.headers.get('authorization')).toBe('Bearer token')
    expect(wsCalls[0]?.request.stream).toBe(true)
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: expect.objectContaining({ text: 'ok' }),
      }),
    )
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'message_stop' }),
    )
  })

  it('normalizes NCode managed model aliases before sending WS v2 requests', async () => {
    const wsCalls: Array<{
      url: string
      request: Record<string, unknown>
      headers: Headers
    }> = []
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              id: 'chatcmpl-kimi27-ws2',
              model: KIMI_2_7_CODER_MODEL,
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'ok' },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          ),
        )
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              id: 'chatcmpl-kimi27-ws2',
              model: KIMI_2_7_CODER_MODEL,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`,
          ),
        )
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'https://api.noumena.com',
      fetch: async () => {
        throw new Error('fetch should not be used for injected WS v2 stream')
      },
      wsV2Transport: async args => {
        wsCalls.push({
          url: args.url,
          request: args.request as Record<string, unknown>,
          headers: args.headers,
        })
        return new Response(stream, { headers: { 'request-id': 'req-kimi27-ws2' } })
      },
    })

    const operation = client.createMessage({
      model: 'Kimi 2.7 Coder',
      stream: true,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    for await (const _event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      // Drain the stream so the injected transport runs to completion.
    }

    expect(wsCalls[0]?.url).toBe('https://api.noumena.com/v1/chat/completions/ws/v2')
    expect(wsCalls[0]?.request.model).toBe(KIMI_2_7_CODER_MODEL)
    expect(wsCalls[0]?.headers.get('x-noumena-model')).toBe('kimi-k25')
  })

  it('falls back to SSE when WS v2 transport setup fails', async () => {
    const fetchCalls: Array<string> = []
    const sseData = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
    const stream = new ReadableStream({
      start(controller) {
        for (const event of [
          sseData({
            id: 'chatcmpl-fallback',
            model: 'test-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'fallback' }, finish_reason: null }],
          }),
          sseData({
            id: 'chatcmpl-fallback',
            model: 'test-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }),
          'data: [DONE]\n\n',
        ]) {
          controller.enqueue(new TextEncoder().encode(event))
        }
        controller.close()
      },
    })

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async input => {
        fetchCalls.push(String(input))
        return new Response(stream, { headers: { 'request-id': 'req-sse-fallback' } })
      },
      wsV2Transport: async () => {
        throw new Error('connect failed')
      },
    })

    const operation = client.createMessage({
      model: 'test-model',
      stream: true,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    const withResponse = await operation.withResponse()
    const seen: Array<Record<string, unknown>> = []
    for await (const event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
      seen.push(event)
    }

    expect(fetchCalls).toEqual(['http://example.test/v1/chat/completions'])
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        delta: expect.objectContaining({ text: 'fallback' }),
      }),
    )
  })

  it('wraps fetch transport failures for retry classification', async () => {
    const cause = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    })
    const fetchError = new TypeError('fetch failed')
    ;(fetchError as Error & { cause?: unknown }).cause = cause

    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () => {
        throw fetchError
      },
    })

    let caught: unknown
    try {
      await client.createMessage({
        model: 'test-model',
        stream: false,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hello' }],
      } as never)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(OpenAICompatTransportError)
    expect((caught as OpenAICompatTransportError).code).toBe('ECONNRESET')
    expect((caught as OpenAICompatTransportError).originalError).toBe(
      fetchError,
    )
  })

  it('wraps streaming body read failures for retry classification', async () => {
    const readError = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
    })
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(readError)
      },
    })
    const client = new OpenAICompatInferenceClient({
      baseURL: 'http://example.test',
      fetch: async () =>
        new Response(stream, {
          headers: { 'request-id': 'req-stream-reset' },
        }),
    })

    const withResponse = await client
      .createMessage({
        model: 'test-model',
        stream: true,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hello' }],
      } as never)
      .withResponse()

    let caught: unknown
    try {
      for await (const _event of withResponse.data as AsyncIterable<Record<string, unknown>>) {
        // Drain until the body read error is observed.
      }
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(OpenAICompatTransportError)
    expect((caught as OpenAICompatTransportError).code).toBe('ECONNRESET')
    expect((caught as OpenAICompatTransportError).originalError).toBe(readError)
  })

})
