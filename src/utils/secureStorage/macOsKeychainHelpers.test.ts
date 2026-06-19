import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'bun:test'

import { getOauthConfig } from '../../constants/oauth.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
} from './macOsKeychainHelpers.js'

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

describe('macOS keychain service names', () => {
  it('uses a Noumena-owned service name for default credentials', () => {
    delete process.env.NCODE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR

    expect(
      getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
    ).toBe(`Noumena Code${getOauthConfig().OAUTH_FILE_SUFFIX}-credentials`)
  })

  it('ignores CLAUDE_CONFIG_DIR when deriving ncode keychain isolation', () => {
    delete process.env.NCODE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-code-config'

    expect(
      getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
    ).toBe(`Noumena Code${getOauthConfig().OAUTH_FILE_SUFFIX}-credentials`)
  })

  it('hashes explicit NCODE_CONFIG_DIR values', () => {
    process.env.NCODE_CONFIG_DIR = '/tmp/ncode-config'
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-code-config'
    const hash = createHash('sha256')
      .update('/tmp/ncode-config')
      .digest('hex')
      .substring(0, 8)

    expect(
      getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
    ).toBe(
      `Noumena Code${getOauthConfig().OAUTH_FILE_SUFFIX}-credentials-${hash}`,
    )
  })
})
