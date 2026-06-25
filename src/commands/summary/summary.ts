import { isInternalBuild } from 'src/capabilities/static.js'
import { manuallyExtractSessionMemory } from '../../services/SessionMemory/sessionMemory.js'
import {
  getSessionMemoryContent,
  waitForSessionMemoryExtraction,
} from '../../services/SessionMemory/sessionMemoryUtils.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getDisplayPath } from '../../utils/file.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'

const HELP_FLAGS = new Set(['--help', '-h', 'help'])

function text(value: string): { type: 'text'; value: string } {
  return { type: 'text', value }
}

function usage(): string {
  return ['Usage:', '  /summary', '  /summary --help'].join('\n')
}

export const call: LocalCommandCall = async (args, context) => {
  if (!isInternalBuild()) {
    return text('`/summary` is only available in ANT builds.')
  }

  const trimmed = args.trim()
  if (trimmed && HELP_FLAGS.has(trimmed.toLowerCase())) {
    return text(usage())
  }
  if (trimmed) {
    return text(`Unknown argument "${trimmed}".\n\n${usage()}`)
  }

  const messages = getMessagesAfterCompactBoundary(context.messages)
  if (messages.length === 0) {
    return text('No messages to summarize.')
  }

  await waitForSessionMemoryExtraction()

  const result = await manuallyExtractSessionMemory(messages, context)
  if (!result.success) {
    return text(
      `Session summary update failed: ${result.error ?? 'unknown error'}`,
    )
  }

  await waitForSessionMemoryExtraction()

  const memoryPath = result.memoryPath ?? getSessionMemoryPath()
  const sessionMemory = await getSessionMemoryContent()

  if (!sessionMemory) {
    return text(
      `Session summary updated at ${getDisplayPath(memoryPath)}, but no summary content is currently available.`,
    )
  }

  return text(
    `Session summary updated: ${getDisplayPath(memoryPath)}\n\n${sessionMemory}`,
  )
}
