import { describe, expect, it, mock } from 'bun:test'

process.env.NOUMENA_API_KEY ??= 'test-key-for-hermetic-contracts'

const actualModel = await import(import.meta.resolve('../utils/model/model.ts'))

mock.module(import.meta.resolve('../utils/model/model.js'), () => ({
  ...actualModel,
  getMainLoopModel: () => 'claude-sonnet-4-6',
  getSmallFastModel: () => 'claude-haiku-4-5',
}))

import { getSimplePrompt } from './BashTool/prompt.js'
import { DESCRIPTION as GLOB_DESCRIPTION } from './GlobTool/prompt.js'
import { getDescription as getGrepDescription } from './GrepTool/prompt.js'
import { JSReplTool } from './REPLTool/JSReplTool.js'
import { PyReplTool } from './REPLTool/PyReplTool.js'
import { REPLTool } from './REPLTool/REPLTool.js'
import {
  getPrimaryDirectToolNames,
  getToolTier,
} from './toolPolicy.js'

describe('direct tool prompt routing', () => {
  it('steers Bash toward scoped repo search instead of blocking it', () => {
    const prompt = getSimplePrompt()
    expect(prompt).toContain(
      'File and directory discovery: Use Glob for broad discovery (respects .gitignore; fast on large repos). Use scoped Bash `find` or `ls` only for concrete, limited directories.',
    )
    expect(prompt).toContain(
      'Content search: Use Grep for regex search across the codebase (respects .gitignore; memory-safe). Use Bash `rg` only for ad-hoc edge cases or when the output mode needs raw shell piping.',
    )
    expect(prompt).toContain(
      'use a targeted existence check like `test -d "parent"` rather than broad directory-listing commands.',
    )
    expect(prompt).toContain(
      'For repository inspection, code review, and codebase exploration tasks, do not use `sl root`, `sl status`, or `pwd` to establish context.',
    )
    expect(prompt).toContain(
      'Prefer scoped Bash discovery such as `find <dir>` for path discovery and `rg` for content search, then use Read on concrete file paths. Use Glob or Grep when their structured parameters are a better fit.',
    )
    expect(prompt).toContain(
      'Avoid broad repo-root enumeration (`find .`, `rg --files .`, `ls -R`, `tree`, or file-counting passes)',
    )
    expect(prompt).toContain(
      'If both `sl` and `git` are available for repository status, history, or diff work, support both but prefer `sl` by default.',
    )
    expect(prompt).not.toContain(
      'first use this tool to run `ls` to verify the parent directory exists',
    )
  })

  it('steers directory inspection from Read to scoped Bash find/ls instead of treating Glob as mandatory', async () => {
    const {
      LINE_FORMAT_INSTRUCTION,
      OFFSET_INSTRUCTION_DEFAULT,
      renderPromptTemplate,
    } = await import('./FileReadTool/prompt.js')
    const prompt = renderPromptTemplate(
      LINE_FORMAT_INSTRUCTION,
      '',
      OFFSET_INSTRUCTION_DEFAULT,
    )
    expect(prompt).toContain(
      'To inspect a directory, prefer the Bash tool with a scoped `find` or a targeted `ls` command.',
    )
    expect(prompt).toContain(
      'If the Glob tool is available and a glob pattern is the clearest fit, you may use it instead.',
    )
    expect(prompt).not.toContain(
      'To inspect a directory, use the Glob tool to enumerate files and subdirectories.',
    )
  })

  it('classifies Glob and Grep as structured helpers instead of mandatory first-line tools', () => {
    expect(GLOB_DESCRIPTION).toContain(
      'Structured helper for glob-pattern file and directory discovery',
    )
    expect(GLOB_DESCRIPTION).toContain(
      'Use this tool when glob syntax is simpler than Bash `find`',
    )
    expect(getGrepDescription()).toContain(
      'Structured ripgrep-backed helper for content search.',
    )
    expect(getGrepDescription()).toContain(
      'Prefer Bash `rg` for routine scoped content search.',
    )
    expect(getGrepDescription()).toContain(
      'Use Glob or Bash `find` for file or directory name discovery.',
    )
  })

  it('classifies REPL as second-line orchestration rather than first-line discovery', async () => {
    const prompt = await REPLTool.prompt()
    expect(getToolTier('REPL')).toBe('opt_in_only')
    expect(prompt).toContain(
      'Use REPL as a high-power orchestration tool when you need multi-step control flow',
    )
    expect(prompt).toContain(
      `Default first-line direct tools are: ${getPrimaryDirectToolNames().join(', ')}.`,
    )
    expect(prompt).toContain(
      'Do NOT use REPL for basic repo discovery, simple file reads, simple path/content searches, simple SCM status/log/diff, or single Bash commands',
    )
  })

  it('classifies js_repl as a separate JavaScript kernel rather than first-line discovery', async () => {
    const prompt = await JSReplTool.prompt()
    expect(getToolTier('js_repl')).toBe('opt_in_only')
    expect(prompt).toContain(
      'Run JavaScript in a persistent Node-backed kernel with top-level await.',
    )
    expect(prompt).toContain(
      `Default first-line direct tools are: ${getPrimaryDirectToolNames().join(', ')}.`,
    )
    expect(prompt).toContain(
      'Prefer direct tools for basic repo discovery, simple file reads, simple path/content search, simple SCM status/log/diff, and single shell commands.',
    )
    expect(prompt).toContain('Use await codex.tool(name, args) to call tools by name.')
  })

  it('classifies py_repl as a separate Python kernel rather than first-line discovery', async () => {
    const prompt = await PyReplTool.prompt()
    expect(getToolTier('py_repl')).toBe('opt_in_only')
    expect(prompt).toContain(
      'Run Python in a persistent kernel with top-level await.',
    )
    expect(prompt).toContain(
      `Default first-line direct tools are: ${getPrimaryDirectToolNames().join(', ')}.`,
    )
    expect(prompt).toContain(
      'Prefer direct tools for basic repo discovery, simple file reads, simple path/content search, simple SCM status/log/diff, and single shell commands.',
    )
    expect(prompt).toContain('Use await codex.tool(name, args) to call tools by name.')
  })
})
