import { mkdir, mkdtemp, rm } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'bun:test'

import {
  getCanonicalNcodeConfigHomeDir,
  getClaudeConfigHomeDir,
  getLegacyClaudeConfigHomeDir,
  getNcodeConfigHomeDir,
  isBareMode,
  shouldMaintainProjectWorkingDir,
} from './envUtils.js'

const ENV_VARS = [
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'NCODE_SIMPLE',
  'CLAUDE_CODE_SIMPLE',
  'NCODE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
  'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
] as const

const ORIGINAL_ENV = Object.fromEntries(
  ENV_VARS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_VARS)[number], string | undefined>

afterEach(() => {
  for (const envVar of ENV_VARS) {
    const original = ORIGINAL_ENV[envVar]
    if (original === undefined) {
      delete process.env[envVar]
    } else {
      process.env[envVar] = original
    }
  }
})

describe('envUtils product env aliases', () => {
  it('treats NCODE_SIMPLE as the default bare-mode env', () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    process.env.NCODE_SIMPLE = '1'

    expect(isBareMode()).toBe(true)
  })

  it('keeps the legacy bare-mode env as a compatibility alias', () => {
    delete process.env.NCODE_SIMPLE
    process.env.CLAUDE_CODE_SIMPLE = '1'

    expect(isBareMode()).toBe(true)
  })

  it('prefers the NCode working-dir env and falls back to the legacy alias', () => {
    delete process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR
    process.env.NCODE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '1'
    expect(shouldMaintainProjectWorkingDir()).toBe(true)

    delete process.env.NCODE_BASH_MAINTAIN_PROJECT_WORKING_DIR
    process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '1'
    expect(shouldMaintainProjectWorkingDir()).toBe(true)
  })
})

describe('ncode config home ownership', () => {
  it('defaults to ~/.ncode even when a Claude config dir exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ncode-home-'))
    const claudeDir = join(root, 'claude')
    try {
      delete process.env.NCODE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = claudeDir
      await mkdir(claudeDir, { recursive: true })

      expect(getCanonicalNcodeConfigHomeDir()).toBe(join(homedir(), '.ncode'))
      expect(getNcodeConfigHomeDir()).toBe(join(homedir(), '.ncode'))
      expect(getClaudeConfigHomeDir()).toBe(join(homedir(), '.ncode'))
      expect(getLegacyClaudeConfigHomeDir()).toBe(claudeDir)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores CLAUDE_CONFIG_DIR for ncode-owned state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ncode-config-home-'))
    const ncodeDir = join(root, 'ncode')
    const claudeDir = join(root, 'claude')
    try {
      process.env.NCODE_CONFIG_DIR = ncodeDir
      process.env.CLAUDE_CONFIG_DIR = claudeDir

      expect(getNcodeConfigHomeDir()).toBe(ncodeDir)
      expect(getClaudeConfigHomeDir()).toBe(ncodeDir)
      expect(getLegacyClaudeConfigHomeDir()).toBe(claudeDir)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
