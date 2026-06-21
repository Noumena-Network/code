import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  createAssistantMessage,
  createUserMessage,
} from './messages.js'
import {
  extractReadFilesFromMessages,
  isResultSuccessful,
  normalizeMessage,
} from './queryHelpers.js'

function createBashProgressMessage({
  parentToolUseID,
  toolUseID,
  elapsedTimeSeconds = 12,
  taskId = 'task-1',
}: {
  parentToolUseID: string
  toolUseID: string
  elapsedTimeSeconds?: number
  taskId?: string
}) {
  return {
    type: 'progress' as const,
    data: {
      type: 'bash_progress' as const,
      elapsedTimeSeconds,
      taskId,
    },
    toolUseID,
    parentToolUseID,
    uuid: `uuid-${toolUseID}`,
    timestamp: new Date().toISOString(),
  }
}

beforeEach(() => {
  delete process.env.CLAUDE_CODE_REMOTE
  delete process.env.CLAUDE_CODE_CONTAINER_ID
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_REMOTE
  delete process.env.CLAUDE_CODE_CONTAINER_ID
})

describe('isResultSuccessful', () => {
  it('treats assistant text responses as successful results', () => {
    expect(isResultSuccessful(createAssistantMessage({ content: 'done' }))).toBe(
      true,
    )
  })

  it('rejects thinking-only assistant responses as silent turn output', () => {
    expect(
      isResultSuccessful(
        createAssistantMessage({
          content: [
            {
              type: 'thinking',
              thinking: 'step by step',
              signature: 'sig',
            } as never,
          ],
        }),
      ),
    ).toBe(false)
    expect(
      isResultSuccessful(
        createAssistantMessage({
          content: [
            {
              type: 'redacted_thinking',
              data: 'opaque',
            } as never,
          ],
        }),
      ),
    ).toBe(false)
  })

  it('accepts tool-result-only user messages as successful turn output', () => {
    expect(
      isResultSuccessful(
        createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: 'ok',
              tool_use_id: 'tool-1',
            } as never,
          ],
        }),
      ),
    ).toBe(true)
  })

  it('keeps the empty end_turn carve-out without treating ordinary prompts as success', () => {
    const prompt = createUserMessage({ content: 'continue' })

    expect(isResultSuccessful(prompt)).toBe(false)
    expect(isResultSuccessful(prompt, 'end_turn')).toBe(true)
  })

  it('rejects missing results and non-terminal assistant tool-use blocks', () => {
    expect(
      isResultSuccessful(
        createAssistantMessage({
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: {},
            } as never,
          ],
        }),
      ),
    ).toBe(false)
  })
})

describe('normalizeMessage', () => {
  it('suppresses empty assistant messages that only carry the no-content sentinel', () => {
    expect([...normalizeMessage(createAssistantMessage({ content: '' }))]).toEqual(
      [],
    )
  })

  it('does not emit bash progress updates outside remote/container sessions', () => {
    expect(
      [
        ...normalizeMessage(
          createBashProgressMessage({
            parentToolUseID: 'parent-local',
            toolUseID: 'progress-local',
          }) as never,
        ),
      ],
    ).toEqual([])
  })

  it('throttles bash progress updates per parent tool use in remote sessions', () => {
    process.env.CLAUDE_CODE_REMOTE = '1'

    const first = [
      ...normalizeMessage(
        createBashProgressMessage({
          parentToolUseID: 'parent-remote',
          toolUseID: 'progress-1',
          elapsedTimeSeconds: 33,
          taskId: 'task-remote',
        }) as never,
      ),
    ]
    const second = [
      ...normalizeMessage(
        createBashProgressMessage({
          parentToolUseID: 'parent-remote',
          toolUseID: 'progress-2',
          elapsedTimeSeconds: 34,
          taskId: 'task-remote',
        }) as never,
      ),
    ]

    expect(first).toEqual([
      expect.objectContaining({
        type: 'tool_progress',
        tool_use_id: 'progress-1',
        tool_name: 'Bash',
        parent_tool_use_id: 'parent-remote',
        elapsed_time_seconds: 33,
        task_id: 'task-remote',
      }),
    ])
    expect(second).toEqual([])
  })
})

describe('extractReadFilesFromMessages', () => {
  it('seeds the readFileState cache from successful Write tool_use', () => {
    const messages = [
      createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'write-ok',
            name: 'Write',
            input: { file_path: '/tmp/foo.txt', content: 'hello world' },
          } as never,
        ],
      }),
      createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'write-ok',
            content: 'wrote 1 file',
            is_error: false,
          } as never,
        ],
      }),
    ]

    const cache = extractReadFilesFromMessages(messages, '/tmp')
    expect(cache.has('/tmp/foo.txt')).toBe(true)
    expect(cache.get('/tmp/foo.txt')?.content).toBe('hello world')
  })

  it('skips Write tool_results that returned is_error', () => {
    const messages = [
      createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'write-failed',
            name: 'Write',
            input: { file_path: '/tmp/bar.txt', content: 'never written' },
          } as never,
        ],
      }),
      createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'write-failed',
            content: 'error: invalid path',
            is_error: true,
          } as never,
        ],
      }),
    ]

    const cache = extractReadFilesFromMessages(messages, '/tmp')
    expect(cache.has('/tmp/bar.txt')).toBe(false)
  })

  it('does not crash when a failed Write carried non-string content', () => {
    const messages = [
      createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'write-malformed',
            name: 'Write',
            input: { file_path: '/tmp/baz.txt', content: { weird: 'object' } },
          } as never,
        ],
      }),
      createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'write-malformed',
            content: 'error: content must be a string',
            is_error: true,
          } as never,
        ],
      }),
    ]

    // Should not throw.
    const cache = extractReadFilesFromMessages(messages, '/tmp')
    expect(cache.has('/tmp/baz.txt')).toBe(false)
    expect(cache.size).toBe(0)
  })
})
