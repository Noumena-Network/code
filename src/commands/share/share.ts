import { isInternalBuild } from 'src/capabilities/static.js'
import { randomUUID } from 'crypto'
import { submitTranscriptShare } from '../../components/FeedbackSurvey/submitTranscriptShare.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'

const HELP_FLAGS = new Set(['--help', '-h', 'help'])
const DEFAULT_TRIGGER = 'frustration' as const

function text(value: string): { type: 'text'; value: string } {
  return { type: 'text', value }
}

function usage(): string {
  return ['Usage:', '  /share', '  /share --help'].join('\n')
}

function toCcshareUrl(transcriptId: string): string {
  if (/^https?:\/\//i.test(transcriptId)) {
    return transcriptId
  }
  return `https://go/ccshare/${transcriptId}`
}

export const call: LocalCommandCall = async (args, context) => {
  if (!isInternalBuild()) {
    return text('`/share` is only available in ANT builds.')
  }
  if (isEssentialTrafficOnly() || !isPolicyAllowed('allow_product_feedback')) {
    return text('`/share` is blocked by current privacy/org policy settings.')
  }

  const trimmed = args.trim()
  if (trimmed && HELP_FLAGS.has(trimmed.toLowerCase())) {
    return text(usage())
  }
  if (trimmed) {
    return text(`Unknown argument "${trimmed}".\n\n${usage()}`)
  }

  const appearanceId = randomUUID()
  const result = await submitTranscriptShare(
    context.messages,
    DEFAULT_TRIGGER,
    appearanceId,
  )

  if (!result.success) {
    return text(
      'Failed to share transcript. Ensure you are authenticated and try again.',
    )
  }
  if (!result.transcriptId) {
    return text(
      'Transcript upload succeeded but no transcript ID was returned by the server.',
    )
  }

  const ccshareUrl = toCcshareUrl(result.transcriptId)
  return text(
    `Transcript shared successfully.\nccshare: ${ccshareUrl}`,
  )
}
