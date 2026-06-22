import { describe, expect, it } from 'bun:test'
import {
  CYBER_RISK_MITIGATION_REMINDER,
  FileReadTool,
} from './FileReadTool.js'

describe('FileReadTool result serialization', () => {
  it('does not append the malware mitigation reminder to benign file reads', () => {
    const block = FileReadTool.mapToolResultToToolResultBlockParam!(
      {
        type: 'text',
        file: {
          filePath: '/tmp/benign.ts',
          content: 'export const ok = true\n',
          startLine: 1,
          totalLines: 1,
        },
      } as never,
      'toolu_read',
    )

    expect(block.type).toBe('tool_result')
    expect(typeof block.content).toBe('string')
    expect(String(block.content)).toContain('export const ok = true')
    expect(String(block.content)).not.toContain(CYBER_RISK_MITIGATION_REMINDER)
    expect(String(block.content)).not.toContain('would be considered malware')
  })
})
