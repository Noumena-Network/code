import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getExistingPlainTextStoragePath,
  getPlainTextStorageReadPaths,
  getPrimaryPlainTextStoragePath,
  plainTextStorage,
} from './plainTextStorage.js'

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

describe('plainTextStorage ncode isolation', () => {
  it('prefers the explicit NCODE_CONFIG_DIR credential file when present', async () => {
    const ncodeDir = await mkdtemp(join(tmpdir(), 'ncode-credentials-'))
    const legacyDir = await mkdtemp(join(tmpdir(), 'legacy-credentials-'))
    try {
      process.env.NCODE_CONFIG_DIR = ncodeDir
      process.env.CLAUDE_CONFIG_DIR = legacyDir
      await writeFile(
        join(ncodeDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'primary-token' } }),
        'utf8',
      )
      await writeFile(
        join(legacyDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'legacy-token' } }),
        'utf8',
      )

      expect(getPrimaryPlainTextStoragePath()).toBe(
        join(ncodeDir, '.credentials.json'),
      )
      expect(getExistingPlainTextStoragePath()).toBe(
        join(ncodeDir, '.credentials.json'),
      )
      expect(plainTextStorage.read()).toEqual({
        claudeAiOauth: { accessToken: 'primary-token' },
      })
    } finally {
      await rm(ncodeDir, { recursive: true, force: true })
      await rm(legacyDir, { recursive: true, force: true })
    }
  })

  it('does not read, overwrite, or delete legacy Claude credentials', async () => {
    const ncodeDir = await mkdtemp(join(tmpdir(), 'ncode-credentials-'))
    const legacyDir = await mkdtemp(join(tmpdir(), 'legacy-credentials-'))
    const legacyCredentialPath = join(legacyDir, '.credentials.json')
    const legacyCredentialJson = JSON.stringify({
      claudeAiOauth: { accessToken: 'legacy-claude-token' },
    })
    try {
      process.env.NCODE_CONFIG_DIR = ncodeDir
      process.env.CLAUDE_CONFIG_DIR = legacyDir
      await writeFile(legacyCredentialPath, legacyCredentialJson, 'utf8')

      expect(getPlainTextStorageReadPaths()).toEqual([
        join(ncodeDir, '.credentials.json'),
      ])
      expect(getExistingPlainTextStoragePath()).toBeNull()
      expect(plainTextStorage.read()).toBeNull()

      expect(
        plainTextStorage.update({
          claudeAiOauth: { accessToken: 'ncode-token' },
        }),
      ).toMatchObject({
        success: true,
      })
      expect(await readFile(legacyCredentialPath, 'utf8')).toBe(
        legacyCredentialJson,
      )
      expect(plainTextStorage.read()).toEqual({
        claudeAiOauth: { accessToken: 'ncode-token' },
      })

      expect(plainTextStorage.delete()).toBe(true)
      expect(await readFile(legacyCredentialPath, 'utf8')).toBe(
        legacyCredentialJson,
      )
    } finally {
      await rm(ncodeDir, { recursive: true, force: true })
      await rm(legacyDir, { recursive: true, force: true })
    }
  })
})
