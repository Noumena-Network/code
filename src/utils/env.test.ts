import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'bun:test'

import { getGlobalNcodeFile } from './env.js'

const ENV_VARS = ['NCODE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR'] as const

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

describe('global ncode config path', () => {
  it('defaults to ~/.ncode/.config.json and ignores Claude global config files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ncode-global-home-'))
    const claudeDir = join(root, 'claude')
    try {
      delete process.env.NCODE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = claudeDir
      await mkdir(claudeDir, { recursive: true })
      await writeFile(join(root, '.claude.json'), '{}', 'utf8')

      expect(getGlobalNcodeFile()).toBe(
        join(homedir(), '.ncode', '.config.json'),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses NCODE_CONFIG_DIR and ignores CLAUDE_CONFIG_DIR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ncode-global-config-'))
    const ncodeDir = join(root, 'ncode')
    const claudeDir = join(root, 'claude')
    try {
      process.env.NCODE_CONFIG_DIR = ncodeDir
      process.env.CLAUDE_CONFIG_DIR = claudeDir

      expect(getGlobalNcodeFile()).toBe(join(ncodeDir, '.config.json'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
