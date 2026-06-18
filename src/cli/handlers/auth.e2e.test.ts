import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setIsInteractive } from '../../bootstrap/state.js'
import { performAuthLogin } from './auth.js'
import {
  createMockOauthBrowserHarness,
  createMockOauthServer,
  parseAuthCliOutputEvents,
  type MockOauthBrowserHarness,
  type MockOauthServer,
  waitForPrintedOauthUrl,
  withMockOauthEnvironment,
} from '../../services/oauth/oauthTestHarness.js'
import { enableConfigs, _setGlobalConfigCacheForTesting } from '../../utils/config.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'

const envKeys = [
  'NODE_ENV',
  'CI',
  'NOUMENA_ISSUER_BASE_URL',
  'NOUMENA_OAUTH_WEB_BASE_URL',
  'NOUMENA_PLATFORM_BASE_URL',
  'NOUMENA_OAUTH_CLIENT_ID',
  'NCODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'BROWSER',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'NOUMENA_API_KEY',
  'CLAUDE_CODE_ENTRYPOINT',
  'USER_TYPE',
  'CLAUDE_CODE_REMOTE',
] as const

const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

const liveServers: MockOauthServer[] = []
const liveBrowsers: MockOauthBrowserHarness[] = []
let tempConfigDir = ''

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function restoreEnv(): void {
  for (const key of envKeys) {
    restoreEnvVar(key, originalEnv[key])
  }
}

function setStableTestRuntime(): void {
  process.env.NODE_ENV = 'production'
  delete process.env.CI
  process.env.NCODE_CONFIG_DIR = tempConfigDir
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.NCODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.NOUMENA_API_KEY
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_REMOTE
}

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'ncode-auth-handler-e2e-'))
  restoreEnv()
  setStableTestRuntime()
  setIsInteractive(true)
  enableConfigs()
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
})

afterEach(async () => {
  clearOAuthTokenCache()
  getSecureStorage().delete()
  _setGlobalConfigCacheForTesting(null)
  restoreEnv()
  while (liveBrowsers.length > 0) {
    await liveBrowsers.pop()!.close()
  }
  while (liveServers.length > 0) {
    await liveServers.pop()!.close()
  }
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = ''
  }
})

afterAll(() => {
  restoreEnv()
})

describe('performAuthLogin cross-machine managed auth end-to-end', () => {
  it('completes managed login from the printed callback-relay URL when the automatic browser path is unavailable', async () => {
    const server = await createMockOauthServer()
    liveServers.push(server)

    const browser = await createMockOauthBrowserHarness({
      mode: 'record-only',
    })
    liveBrowsers.push(browser)

    await withMockOauthEnvironment(server, async () => {
      process.env.BROWSER = browser.command
      process.env.NCODE_CONFIG_DIR = tempConfigDir
      process.env.CLAUDE_CONFIG_DIR = tempConfigDir

      const stdoutChunks: string[] = []
      const originalStdoutWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutChunks.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        )
        return true
      }) as typeof process.stdout.write

      try {
        const loginPromise = performAuthLogin({ managed: true })
        const manualUrl = await waitForPrintedOauthUrl(() => stdoutChunks.join(''))
        const relay = await server.completeRelayFlow(manualUrl)

        await expect(loginPromise).resolves.toBeUndefined()

        expect(relay.relayId).toBeTruthy()
        expect(relay.code).toBe('auth-code-1')
        expect(relay.state).toBeTruthy()

        const browserInvocations = await browser.readInvocations()
        expect(browserInvocations).toHaveLength(1)
        expect(browserInvocations[0]).toContain('/oauth/authorize')
        expect(browserInvocations[0]).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A')

        expect(server.relayCompletions).toHaveLength(1)
        expect(server.tokenRequests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              grant_type: 'authorization_code',
              code: 'auth-code-1',
              client_id: 'noumena-code-test',
            }),
          ]),
        )

        const storedTokens = getSecureStorage().read()?.claudeAiOauth
        expect(storedTokens).toMatchObject({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        })

        const outputEvents = parseAuthCliOutputEvents(stdoutChunks.join(''))
        expect(outputEvents.map(event => event.type)).toEqual([
          'opening_browser',
          'manual_url',
          'login_success',
        ])
        expect(outputEvents[1]).toMatchObject({
          type: 'manual_url',
          url: manualUrl,
        })
      } finally {
        process.stdout.write = originalStdoutWrite
      }
    })
  })
})
