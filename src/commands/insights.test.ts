import { describe, expect, it } from 'bun:test'
import { extractToolStats } from './insights.js'
import type { LogOption } from '../types/logs.js'

type ToolBlockInput = {
  name: string
  input: Record<string, unknown>
}

function buildLog(toolInputs: ToolBlockInput[]): LogOption {
  return {
    date: '2026-06-22',
    messages: [
      {
        type: 'assistant',
        cwd: '/tmp',
        userType: 'external',
        sessionId: 'session',
        timestamp: '2026-06-22T00:00:00.000Z',
        version: '1.0.0',
        message: {
          id: 'message',
          type: 'message',
          role: 'assistant',
          model: 'model',
          content: toolInputs.map((toolInput, index) => ({
            type: 'tool_use',
            id: `tool-${index}`,
            name: toolInput.name,
            input: toolInput.input,
          })),
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    ],
    fullPath: '/tmp/session.jsonl',
    value: 0,
    created: new Date('2026-06-22T00:00:00.000Z'),
    modified: new Date('2026-06-22T00:00:00.000Z'),
    firstPrompt: '',
    messageCount: 1,
    isSidechain: false,
  } as unknown as LogOption
}

describe('extractToolStats', () => {
  it('does not count malformed Edit strings as changed lines', () => {
    const stats = extractToolStats(
      buildLog([
        {
          name: 'Edit',
          input: {
            file_path: 'src/valid.ts',
            old_string: 'before',
            new_string: 'after',
          },
        },
        {
          name: 'Edit',
          input: {
            file_path: 'src/malformed.ts',
            old_string: {},
            new_string: ['after'],
          },
        },
      ]),
    )

    expect(stats.toolCounts.Edit).toBe(2)
    expect(stats.linesAdded).toBe(1)
    expect(stats.linesRemoved).toBe(1)
  })

  it('does not count malformed Write content as added lines', () => {
    const stats = extractToolStats(
      buildLog([
        {
          name: 'Write',
          input: {
            file_path: 'src/valid.ts',
            content: 'one\ntwo',
          },
        },
        {
          name: 'Write',
          input: {
            file_path: 'src/malformed.ts',
            content: { text: 'not a string' },
          },
        },
      ]),
    )

    expect(stats.toolCounts.Write).toBe(2)
    expect(stats.linesAdded).toBe(2)
    expect(stats.linesRemoved).toBe(0)
  })
})
