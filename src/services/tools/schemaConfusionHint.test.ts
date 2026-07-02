import { describe, expect, it } from 'bun:test'
import { buildSchemaConfusionHint } from './schemaConfusionHint.js'

// Reproduces the 7 schema-confusion shapes confirmed during the
// 2026-06-20 live diagnostic exercise + null cases verifying the hint is
// only emitted when genuinely confused.
//
// Shape reference (from live reproduction):
// 1. Bash({ file_path })               → Read-shaped args on Bash
// 2. Bash({ file_path, limit })         → Read-shaped args on Bash (full)
// 3. Bash({ pattern, path, output_mode }) → Grep-shaped args on Bash
// 4. Bash({ pattern })                 → Glob-shaped args on Bash
// 5. Grep({ command, description })    → Bash-shaped args on Grep
// 6. Read({ command, description })    → Bash-shaped args on Read
// 7. Read({ pattern })                 → Glob-shaped args on Read
// Plus Grep({ pattern }) called with a glob-looking pattern → Glob
//
// Extension (2026-06-22): WebFetch and Write added to the cluster after
// log analysis showed GLM-5.2 repeatedly emitting WebFetch({file_path})
// and Write({file_path, limit|offset}) without recovering, because the
// hint never fired for those called tools. The Write/Read `file_path`
// collision is resolved by way of `content` (present → Write, absent →
// possible Read leak) with Read-only optionals (limit/offset/pages) as
// the confirming signal for Read intent.

const ALL_SEARCH_TOOLS = ['Bash', 'Grep', 'Glob', 'Read', 'WebFetch', 'Write']

describe('buildSchemaConfusionHint', () => {
  describe('returns a hint naming the correct target tool for each confirmed shape', () => {
    it('Bash with file_path → hint names Read', () => {
      const hint = buildSchemaConfusionHint('Bash', { file_path: '/tmp/x' }, ALL_SEARCH_TOOLS)
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Read')
      expect(hint!).toContain('file_path')
    })

    it('Bash with file_path+limit → hint names Read', () => {
      const hint = buildSchemaConfusionHint(
        'Bash',
        { file_path: '/tmp/x', limit: 5 },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Read')
      expect(hint!).toContain('file_path')
      expect(hint!).toContain('limit')
    })

    it('Bash with pattern+path+output_mode → hint names Grep', () => {
      const hint = buildSchemaConfusionHint(
        'Bash',
        { pattern: 'foo', path: '/x', output_mode: 'content' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Grep')
      expect(hint!).toContain('pattern')
      expect(hint!).toContain('path')
    })

    it('Bash with bare pattern → hint names Glob', () => {
      const hint = buildSchemaConfusionHint('Bash', { pattern: 'src/*.ts' }, ALL_SEARCH_TOOLS)
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Glob')
      expect(hint!).toContain('pattern')
    })

    it('Grep with command+description → hint names Bash', () => {
      const hint = buildSchemaConfusionHint(
        'Grep',
        { command: 'ls', description: 'list' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Bash')
      expect(hint!).toContain('command')
    })

    it('Read with command+description → hint names Bash', () => {
      const hint = buildSchemaConfusionHint(
        'Read',
        { command: 'ls', description: 'list' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Bash')
      expect(hint!).toContain('command')
    })

    it('Read with bare pattern → hint names Glob', () => {
      const hint = buildSchemaConfusionHint(
        'Read',
        { pattern: 'src/*.ts' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Glob')
      expect(hint!).toContain('pattern')
    })

    it('Grep with a glob-looking pattern → hint names Glob', () => {
      const hint = buildSchemaConfusionHint(
        'Grep',
        { pattern: '/tmp/ncode-glm-sweep/*.txt' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Glob')
      expect(hint!).toContain('pattern')
    })
  })

  describe('does not emit a hint when the call is well-formed for its tool', () => {
    it('returns null for Bash with command', () => {
      const hint = buildSchemaConfusionHint(
        'Bash',
        { command: 'ls' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).toBeNull()
    })

    it('returns null for Read with file_path', () => {
      const hint = buildSchemaConfusionHint(
        'Read',
        { file_path: '/tmp/x' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).toBeNull()
    })

    it('returns null for Grep with pattern+path (real content regex)', () => {
      const hint = buildSchemaConfusionHint(
        'Grep',
        { pattern: 'foo|bar', path: '/x' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).toBeNull()
    })

    it('returns null for Glob with pattern', () => {
      const hint = buildSchemaConfusionHint(
        'Glob',
        { pattern: 'src/*.ts' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).toBeNull()
    })
  })

  describe('does not emit a hint when a sibling tool is missing from the registry', () => {
    it('returns null when Read is not in siblingToolNames (Bash←file_path case)', () => {
      const hint = buildSchemaConfusionHint(
        'Bash',
        { file_path: '/tmp/x' },
        ['Bash', 'Grep', 'Glob'],
      )
      expect(hint).toBeNull()
    })

    it('returns null when Glob is not in siblingToolNames (Grep←pattern case)', () => {
      const hint = buildSchemaConfusionHint(
        'Grep',
        { pattern: '*.ts' },
        ['Bash', 'Grep', 'Read'],
      )
      expect(hint).toBeNull()
    })
  })

  describe('ignored tools outside the search cluster', () => {
    it('returns null when toolName is TaskGet (not a search tool)', () => {
      const hint = buildSchemaConfusionHint(
        'TaskGet',
        { command: 'ls', file_path: '/tmp/x' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).toBeNull()
    })

    it('returns null when input is empty', () => {
      const hint = buildSchemaConfusionHint('Bash', {}, ALL_SEARCH_TOOLS)
      expect(hint).toBeNull()
    })
  })

  describe('ambiguous shapes', () => {
    it('Bash with pattern+path but no other Grep-specific param → hint names Grep (path is the disambiguator)', () => {
      const hint = buildSchemaConfusionHint(
        'Bash',
        { pattern: 'foo', path: '/x' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Grep')
    })

    it('Bash with pattern that is a glob-looking path → hint names Glob (no path field)', () => {
      const hint = buildSchemaConfusionHint(
        'Bash',
        { pattern: 'src/*.ts' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Glob')
    })
  })

  describe('WebFetch extension (2026-06-22)', () => {
    it('WebFetch with file_path → hint names Read', () => {
      const hint = buildSchemaConfusionHint(
        'WebFetch',
        { file_path: '/tmp/x' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Read')
      expect(hint!).toContain('file_path')
    })

    it('WebFetch with file_path+limit → hint names Read', () => {
      const hint = buildSchemaConfusionHint(
        'WebFetch',
        { file_path: '/tmp/x', limit: 5 },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Read')
      expect(hint!).toContain('file_path')
      expect(hint!).toContain('limit')
    })

    it('returns null for well-formed WebFetch with url+prompt', () => {
      const hint = buildSchemaConfusionHint(
        'WebFetch',
        { url: 'https://example.com', prompt: 'summarize' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).toBeNull()
    })
  })

  describe('Write/Read file_path collision (2026-06-22)', () => {
    it('Write with file_path+limit → hint names Read (content absent, Read-only optional present)', () => {
      const hint = buildSchemaConfusionHint(
        'Write',
        { file_path: '/tmp/x', limit: 5 },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Read')
      expect(hint!).toContain('file_path')
      expect(hint!).toContain('limit')
    })

    it('Write with file_path+offset → hint names Read', () => {
      const hint = buildSchemaConfusionHint(
        'Write',
        { file_path: '/tmp/x', offset: 10 },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).not.toBeNull()
      expect(hint!).toContain('Read')
      expect(hint!).toContain('offset')
    })

    it('returns null for Write with only file_path (ambiguous: could be Write missing content OR Read leaking file_path)', () => {
      // When content is absent AND no Read-only optional is present,
      // we cannot tell which tool the model meant. Emit no hint and let
      // the bare Zod error surface the missing `content` requirement.
      const hint = buildSchemaConfusionHint(
        'Write',
        { file_path: '/tmp/x' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).toBeNull()
    })

    it('returns null for Write with file_path+content (well-formed Write)', () => {
      const hint = buildSchemaConfusionHint(
        'Write',
        { file_path: '/tmp/x', content: 'hello' },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).toBeNull()
    })

    it('returns null for Write with file_path+content+limit (well-formed Write with stray param)', () => {
      // `content` present anchors Write intent. The validator will
      // surface `limit` as an unexpected param via the bare Zod error.
      // We do not emit a Read hint here because the called tool's own
      // required keyword (file_path) + content fully express Write
      // intent; the model just included a stray param that doesn't
      // belong to either tool's accepted input shape.
      const hint = buildSchemaConfusionHint(
        'Write',
        { file_path: '/tmp/x', content: 'hello', limit: 5 },
        ALL_SEARCH_TOOLS,
      )
      expect(hint).toBeNull()
    })

    it('returns null when Write is called and Read is missing from the registry', () => {
      // Without Read available, the file_path+limit input on Write
      // cannot route anywhere — emit no hint.
      const hint = buildSchemaConfusionHint(
        'Write',
        { file_path: '/tmp/x', limit: 5 },
        ['Bash', 'Grep', 'Glob', 'WebFetch', 'Write'],
      )
      expect(hint).toBeNull()
    })
  })
})