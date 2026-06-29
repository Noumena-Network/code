import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildConversationChain,
  cleanMessagesForLogging,
  clearSessionMessagesCache,
  flushSessionStorage,
  getAgentTranscript,
  getAgentTranscriptPath,
  loadAllLogsFromSessionFile,
  loadTranscriptFile,
  recordTranscript,
  resetProjectForTesting,
  setSessionFileForTesting,
  TranscriptParseError,
} from './sessionStorage.js'

function createUserMessage(content: string, uuid?: string): any {
  return {
    type: 'user',
    uuid: uuid ?? randomUUID(),
    timestamp: new Date().toISOString(),
    message: { content },
  }
}

function createAssistantMessage(content: string, uuid?: string): any {
  return {
    type: 'assistant',
    uuid: uuid ?? randomUUID(),
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'text', text: content }] },
  }
}

function createProgressMessage(uuid?: string): any {
  return {
    type: 'progress',
    uuid: uuid ?? randomUUID(),
    timestamp: new Date().toISOString(),
    parentToolUseID: 'parent-1',
    toolUseID: 'tool-1',
    data: { type: 'bash_progress', elapsedTimeSeconds: 1, taskId: 't1' },
    message: { content: [] },
  }
}

beforeEach(() => {
  process.env.USER_TYPE = 'noumena'
  resetProjectForTesting()
  setSessionFileForTesting(
    join(
      tmpdir(),
      'ncode-session-storage-tests',
      randomUUID(),
      'session.jsonl',
    ),
  )
  clearSessionMessagesCache()
})

afterEach(() => {
  resetProjectForTesting()
  clearSessionMessagesCache()
})

describe('cleanMessagesForLogging', () => {
  it('returns the same filtered array when called twice with the same reference', () => {
    const messages = [
      createUserMessage('hello'),
      createProgressMessage(),
      createAssistantMessage('reply'),
    ]

    const first = cleanMessagesForLogging(messages)
    const second = cleanMessagesForLogging(messages)

    // Progress messages are filtered out via isLoggableMessage
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    // With the WeakMap cache, second call should return the same array reference
    expect(second).toBe(first)
  })

  it('incrementally appends new tail on array growth', () => {
    const baseMessages = [
      createUserMessage('first'),
      createAssistantMessage('first reply'),
    ]

    const first = cleanMessagesForLogging(baseMessages)
    expect(first).toHaveLength(2)

    // Simulate streaming append (same array reference extended)
    ;(baseMessages as any[]).push(createProgressMessage())
    ;(baseMessages as any[]).push(createUserMessage('second'))

    const second = cleanMessagesForLogging(baseMessages)
    expect(second).toHaveLength(3) // progress filtered out
    expect(second[0]).toBe(first[0]) // prefix reused
    expect(second[1]).toBe(first[1]) // prefix reused
  })

  it('falls back to full filter on reference change', () => {
    const messagesA = [
      createUserMessage('hello'),
      createAssistantMessage('reply'),
    ]

    const first = cleanMessagesForLogging(messagesA)

    const messagesB = [
      createUserMessage('different'),
      createAssistantMessage('different reply'),
    ]

    const second = cleanMessagesForLogging(messagesB)

    expect(second).toHaveLength(2)
    expect(second).not.toBe(first)
  })
})

describe('buildConversationChain', () => {
  it('can follow compact-boundary logical parents for resumed visible history', () => {
    const root = createUserMessage('root', 'root')
    const preCompactTail = createAssistantMessage('pre-compact', 'pre')
    preCompactTail.parentUuid = root.uuid
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'boundary',
      parentUuid: null,
      logicalParentUuid: preCompactTail.uuid,
      timestamp: new Date().toISOString(),
      content: 'Conversation compacted',
    }
    const summary = createUserMessage('summary', 'summary')
    summary.parentUuid = boundary.uuid
    const after = createAssistantMessage('after', 'after')
    after.parentUuid = summary.uuid
    const messages = new Map(
      [root, preCompactTail, boundary, summary, after].map(message => [
        message.uuid,
        message,
      ]),
    )

    expect(buildConversationChain(messages, after).map(m => m.uuid)).toEqual([
      'boundary',
      'summary',
      'after',
    ])
    expect(
      buildConversationChain(messages, after, {
        includeLogicalParents: true,
      }).map(m => m.uuid),
    ).toEqual(['root', 'pre', 'boundary', 'summary', 'after'])
  })
})

describe('loadAllLogsFromSessionFile', () => {
  it('bridges compact-boundary logical parents when building leaf logs', async () => {
    const root = join(
      tmpdir(),
      'ncode-session-storage-tests',
      randomUUID(),
    )
    mkdirSync(root, { recursive: true })
    const sessionFile = join(root, 'compact-logical-parent.jsonl')
    const sessionId = randomUUID()
    const timestamp = '2026-06-09T20:16:19.107Z'
    const common = {
      timestamp,
      sessionId,
      cwd: '/repo',
      isSidechain: false,
    }
    const entries = [
      {
        ...common,
        type: 'user',
        uuid: 'root',
        parentUuid: null,
        message: { role: 'user', content: 'root prompt' },
      },
      {
        ...common,
        type: 'assistant',
        uuid: 'pre',
        parentUuid: 'root',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'pre compact answer' }],
        },
      },
      {
        ...common,
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'boundary',
        parentUuid: null,
        logicalParentUuid: 'pre',
        content: 'Conversation compacted',
      },
      {
        ...common,
        type: 'user',
        uuid: 'summary',
        parentUuid: 'boundary',
        message: { role: 'user', content: 'compact summary' },
      },
      {
        ...common,
        type: 'assistant',
        uuid: 'after',
        parentUuid: 'summary',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'post compact answer' }],
        },
      },
    ]
    writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n'))

    const logs = await loadAllLogsFromSessionFile(sessionFile)

    const postCompactLog = logs.find(log => log.leafUuid === 'after')

    expect(postCompactLog).toBeDefined()
    expect(postCompactLog!.messages.map(message => message.uuid)).toEqual([
      'root',
      'pre',
      'boundary',
      'summary',
      'after',
    ])
  })
})

describe('getAgentTranscript', () => {
  it('bridges compact-boundary logical parents in agent sidechain transcripts', async () => {
    const agentId = `agent-${randomUUID()}` as any
    const agentFile = getAgentTranscriptPath(agentId)
    mkdirSync(join(agentFile, '..'), { recursive: true })
    const sessionId = randomUUID()
    const common = {
      sessionId,
      cwd: '/repo',
      isSidechain: true,
      agentId,
    }
    const entries = [
      {
        ...common,
        type: 'user',
        uuid: 'agent-root',
        parentUuid: null,
        timestamp: '2026-06-09T20:16:00.000Z',
        message: { role: 'user', content: 'agent root prompt' },
      },
      {
        ...common,
        type: 'assistant',
        uuid: 'agent-pre',
        parentUuid: 'agent-root',
        timestamp: '2026-06-09T20:16:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'agent pre compact answer' }],
        },
      },
      {
        ...common,
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'agent-boundary',
        parentUuid: null,
        logicalParentUuid: 'agent-pre',
        timestamp: '2026-06-09T20:16:02.000Z',
        content: 'Conversation compacted',
      },
      {
        ...common,
        type: 'user',
        uuid: 'agent-summary',
        parentUuid: 'agent-boundary',
        timestamp: '2026-06-09T20:16:03.000Z',
        message: { role: 'user', content: 'agent compact summary' },
      },
      {
        ...common,
        type: 'assistant',
        uuid: 'agent-after',
        parentUuid: 'agent-summary',
        timestamp: '2026-06-09T20:16:04.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'agent post compact answer' }],
        },
      },
    ]
    writeFileSync(agentFile, entries.map(entry => JSON.stringify(entry)).join('\n'))

    const transcript = await getAgentTranscript(agentId)

    expect(transcript).not.toBeNull()
    expect(transcript!.messages.map(message => message.uuid)).toEqual([
      'agent-root',
      'agent-pre',
      'agent-boundary',
      'agent-summary',
      'agent-after',
    ])
  })
})

describe('recordTranscript', () => {
  it('records new messages and returns last uuid', async () => {
    const msg1 = createUserMessage('prompt one')
    const msg2 = createAssistantMessage('reply one')

    // First call: empty file, both messages are new
    const result1 = await recordTranscript([msg1, msg2], undefined, undefined)
    expect(result1).toBe(msg2.uuid)
  })

  it('records only unrecorded suffix on subsequent calls', async () => {
    const msg1 = createUserMessage('prompt one')
    const msg2 = createAssistantMessage('reply one')
    const msg3 = createUserMessage('prompt two')

    // First call writes msg1, msg2
    await recordTranscript([msg1, msg2])

    // Second call: msg1, msg2 already recorded; msg3 is new
    const result = await recordTranscript([msg1, msg2, msg3])
    expect(result).toBe(msg3.uuid)
  })

  it('returns last recorded uuid when there is nothing new to record', async () => {
    const msg1 = createUserMessage('prompt')
    const msg2 = createAssistantMessage('reply')

    await recordTranscript([msg1, msg2])
    const result = await recordTranscript([msg1, msg2])

    // All messages already recorded → returns last recorded UUID
    expect(result).toBe(msg2.uuid)
  })
})

describe('loadTranscriptFile parse diagnostics', () => {
  it('returns an empty transcript for a missing file', async () => {
    const missingPath = join(
      tmpdir(),
      'ncode-session-storage-tests',
      randomUUID(),
      'missing.jsonl',
    )

    const result = await loadTranscriptFile(missingPath)

    expect(result.messages.size).toBe(0)
  })

  it('throws TranscriptParseError PARSE with line number for corrupted JSONL', async () => {
    const root = join(tmpdir(), 'ncode-session-storage-tests', randomUUID())
    mkdirSync(root, { recursive: true })
    const badFile = join(root, 'corrupted.jsonl')
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      }),
      '{invalid json on line 3',
    ]
    writeFileSync(badFile, lines.join('\n'))

    let error: unknown
    try {
      await loadTranscriptFile(badFile)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(TranscriptParseError)
    expect((error as TranscriptParseError).code).toBe('PARSE')
    expect((error as TranscriptParseError).line).toBe(3)
    expect((error as TranscriptParseError).filePath).toBe(badFile)
    expect((error as Error).message).not.toContain('invalid json')
  })

  it('loads valid JSONL without error', async () => {
    const root = join(tmpdir(), 'ncode-session-storage-tests', randomUUID())
    mkdirSync(root, { recursive: true })
    const goodFile = join(root, 'valid.jsonl')
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      }),
    ]
    writeFileSync(goodFile, lines.join('\n'))

    const result = await loadTranscriptFile(goodFile)
    expect(result.messages.size).toBe(2)
    expect(result.messages.get('u1')?.type).toBe('user')
  })
})

describe('persistence recovery', () => {
  let prevTestEnableSessionPersistence: string | undefined
  beforeEach(() => {
    prevTestEnableSessionPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  })
  afterEach(() => {
    if (prevTestEnableSessionPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = prevTestEnableSessionPersistence
    }
  })

  it('resumes writes after a transient FS error clears', async () => {
    const root = join(tmpdir(), 'ncode-persist-tests', randomUUID())
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const sessionFile = join(root, 'session.jsonl')
    writeFileSync(sessionFile, '')
    setSessionFileForTesting(sessionFile)

    const msg1 = createUserMessage('one')
    await recordTranscript([msg1])
    await flushSessionStorage()
    expect(readFileSync(sessionFile, 'utf8')).toContain('one')

    // Poison the parent directory: removing x bit makes name lookup fail
    // with EACCES, an isFsInaccessible-class error.
    try {
      chmodSync(root, 0o000)

      const msg2 = createUserMessage('two')
      await recordTranscript([msg2])
      await flushSessionStorage()
    } finally {
      chmodSync(root, 0o700)
    }

    // FS healthy again. The next message MUST persist - previously a
    // single EACCES flipped persistenceUnavailable=true for the lifetime
    // of the process and every subsequent write was silently dropped.
    const msg3 = createUserMessage('three')
    await recordTranscript([msg3])
    await flushSessionStorage()

    expect(readFileSync(sessionFile, 'utf8')).toContain('three')
  })
})
