import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as analytics from '../analytics/index.js'
import { inferSchemaLeakSource } from './schemaConfusionHint.js'

// Tests for the structured telemetry helper that powers
// ncode_schema_leak_rejected. The helper must return exactly the same
// source_tool_inferred / stray_params the hint would name, plus a few
// null cases where we deliberately do not emit.

const ALL_SEARCH_TOOLS = ['Bash', 'Grep', 'Glob', 'Read', 'WebFetch', 'Write']

describe('inferSchemaLeakSource', () => {
  describe('returns source + stray params for each confirmed leak shape', () => {
    it('Bash({ file_path }) → Read, [file_path]', () => {
      const r = inferSchemaLeakSource('Bash', { file_path: '/tmp/x' }, ALL_SEARCH_TOOLS)
      expect(r).toEqual({ source_tool_inferred: 'Read', stray_params: ['file_path'] })
    })

    it('Bash({ file_path, limit }) → Read, [file_path, limit]', () => {
      const r = inferSchemaLeakSource(
        'Bash',
        { file_path: '/tmp/x', limit: 5 },
        ALL_SEARCH_TOOLS,
      )
      expect(r).toEqual({
        source_tool_inferred: 'Read',
        stray_params: ['file_path', 'limit'],
      })
    })

    it('Bash({ pattern, path, output_mode }) → Grep, [pattern, path, output_mode]', () => {
      const r = inferSchemaLeakSource(
        'Bash',
        { pattern: 'foo', path: '/x', output_mode: 'files_with_matches' },
        ALL_SEARCH_TOOLS,
      )
      expect(r).toEqual({
        source_tool_inferred: 'Grep',
        stray_params: ['pattern', 'path', 'output_mode'],
      })
    })

    it('Read({ command, description }) → Bash, [command, description]', () => {
      const r = inferSchemaLeakSource(
        'Read',
        { command: 'ls', description: 'list' },
        ALL_SEARCH_TOOLS,
      )
      expect(r).toEqual({
        source_tool_inferred: 'Bash',
        stray_params: ['command', 'description'],
      })
    })

    it('WebFetch({ file_path }) → Read, [file_path]', () => {
      const r = inferSchemaLeakSource('WebFetch', { file_path: '/x' }, ALL_SEARCH_TOOLS)
      expect(r).toEqual({ source_tool_inferred: 'Read', stray_params: ['file_path'] })
    })
  })

  describe('returns null when no leak is detectable', () => {
    it('called tool outside the search cluster → null', () => {
      // TaskGet is not in SEARCH_TOOL_NAMES; even if its input is
      // shaped like a sibling, we pass through without diagnosing.
      const r = inferSchemaLeakSource('TaskGet', { file_path: '/x' }, ALL_SEARCH_TOOLS)
      expect(r).toBeNull()
    })

    it('well-formed Bash call (own keyword present) → null', () => {
      const r = inferSchemaLeakSource(
        'Bash',
        { command: 'ls', description: 'list' },
        ALL_SEARCH_TOOLS,
      )
      expect(r).toBeNull()
    })

    it('empty input → null', () => {
      const r = inferSchemaLeakSource('Bash', {}, ALL_SEARCH_TOOLS)
      expect(r).toBeNull()
    })

    it('bare Write({ file_path }) with no stray optionals → null', () => {
      // Write's own keyword is file_path; when only file_path is present
      // (no content, no Read-only optionals like limit/offset), we cannot
      // confidently infer Read intent. The bare "required content missing"
      // error from Zod is the best we can offer the model.
      const r = inferSchemaLeakSource('Write', { file_path: '/x' }, ALL_SEARCH_TOOLS)
      expect(r).toBeNull()
    })

    it('Write({ file_path, limit, offset }) → Read, [file_path, limit, offset]', () => {
      // Read-only optionals (limit/offset/pages) disambiguate the Write/Read
      // file_path collision. Their presence without Write's required
      // `content` confirms Read intent.
      const r = inferSchemaLeakSource(
        'Write',
        { file_path: '/x', limit: 5, offset: 10 },
        ALL_SEARCH_TOOLS,
      )
      expect(r).toEqual({
        source_tool_inferred: 'Read',
        stray_params: ['file_path', 'limit', 'offset'],
      })
    })
  })
})

// Telemetry emission smoke test: verifies the right event name and
// field shape surface when a real leak is detected. We don't exercise
// the full rejection path here — that's covered by toolExecution's
// existing tests — we just confirm the helper hook composes correctly
// with the analytics sink.
describe('telemetry wiring', () => {
  const events: Array<{ name: string; metadata: Record<string, unknown> }> = []
  let restore: () => void

  beforeEach(() => {
    events.length = 0
    const spy = spyOn(analytics, 'logEvent').mockImplementation(
      (name: string, metadata: Record<string, unknown>) => {
        events.push({ name, metadata })
      },
    )
    restore = () => spy.mockRestore()
  })

  afterEach(() => restore())

  it('helper result maps cleanly into the ncode_schema_leak_rejected event shape', () => {
    const leak = inferSchemaLeakSource('Bash', { file_path: '/tmp/x' }, ALL_SEARCH_TOOLS)
    expect(leak).not.toBeNull()
    // Simulate the exact call shape toolExecution.ts makes.
    if (leak) {
      analytics.logEvent('ncode_schema_leak_rejected', {
        model: 'glm-5.2',
        target_tool: 'Bash',
        source_tool_inferred: leak.source_tool_inferred,
        stray_params: leak.stray_params,
        missing_required_params: ['command'],
        hint_emitted: true,
        query_chain_id: 'chain-1',
        query_depth: 0,
      })
    }
    expect(events).toHaveLength(1)
    expect(events[0]!.name).toBe('ncode_schema_leak_rejected')
    expect(events[0]!.metadata).toMatchObject({
      model: 'glm-5.2',
      target_tool: 'Bash',
      source_tool_inferred: 'Read',
      stray_params: ['file_path'],
      missing_required_params: ['command'],
      hint_emitted: true,
    })
  })
})