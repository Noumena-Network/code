import { afterEach, describe, expect, it } from 'bun:test'
import {
  buildInitialRemoteControlEvents,
  getRemoteSessionEnvironmentVariables,
  getRemoteSessionEnvironmentVariablesForProviderMode,
  getRemoteSessionEnvironmentVariablesForRuntimeLease,
  getRemoteSessionRuntimeForRuntimeLease,
  redactRemoteSessionEnvironmentVariables,
} from './teleport.js'

const ORIGINAL_ENV = {
  NOUMENA_BASE_URL: process.env.NOUMENA_BASE_URL,
  NOUMENA_MODEL: process.env.NOUMENA_MODEL,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
}

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  delete process.env.UNRELATED_REMOTE_TEST_ENV
})

describe('buildInitialRemoteControlEvents', () => {
  it('defaults remote execution to bypass permissions', () => {
    expect(buildInitialRemoteControlEvents({})).toEqual([
      {
        type: 'event',
        data: {
          type: 'control_request',
          request_id: expect.stringMatching(/^set-mode-/),
          request: {
            subtype: 'set_permission_mode',
            mode: 'bypassPermissions',
            ultraplan: undefined,
          },
        },
      },
    ])
  })

  it('preserves explicit permission modes', () => {
    expect(buildInitialRemoteControlEvents({ permissionMode: 'plan' })[0]?.data)
      .toMatchObject({
        request: {
          subtype: 'set_permission_mode',
          mode: 'plan',
        },
      })
  })

  it('does not force bypass permissions for ultraplan', () => {
    expect(buildInitialRemoteControlEvents({ ultraplan: true })).toEqual([])
  })
})

describe('getRemoteSessionEnvironmentVariables', () => {
  it('inherits managed routing env vars from the current process', () => {
    process.env.NOUMENA_BASE_URL = 'http://internal-gateway.invalid'
    process.env.NOUMENA_MODEL = '/data/models/hf/moonshotai__Kimi-K2.7-Code'
    process.env.UNRELATED_REMOTE_TEST_ENV = 'ignored'

    expect(getRemoteSessionEnvironmentVariables()).toEqual({
      NOUMENA_BASE_URL: 'http://internal-gateway.invalid',
      NOUMENA_MODEL: '/data/models/hf/moonshotai__Kimi-K2.7-Code',
    })
  })

  it('lets explicit overrides replace inherited values', () => {
    process.env.NOUMENA_BASE_URL = 'http://internal-gateway.invalid'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'

    expect(
      getRemoteSessionEnvironmentVariables({
        NOUMENA_BASE_URL:
          'https://internal-override.invalid',
      }),
    ).toMatchObject({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      NOUMENA_BASE_URL:
        'https://internal-override.invalid',
    })
  })

  it('uses direct provider routing for remote BYOK sessions', () => {
    process.env.NOUMENA_BASE_URL = 'http://internal-gateway.invalid'
    process.env.NOUMENA_MODEL = 'opus'

    expect(
      getRemoteSessionEnvironmentVariablesForProviderMode(undefined, 'byok'),
    ).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      NOUMENA_MODEL: 'opus',
    })
  })

  it('injects managed remote runtime lease credentials for normal remote sessions', () => {
    process.env.NOUMENA_BASE_URL = 'https://code.dev.noumena.test'
    process.env.NOUMENA_MODEL = 'opus'

    expect(
      getRemoteSessionEnvironmentVariablesForRuntimeLease(undefined, {
        accessToken: 'managed-access-token',
        orgUUID: 'org-remote',
        session: {} as never,
        lease: {
          leaseId: 'remote_session:pending:org-remote',
          leaseKind: 'remote_session',
          state: 'usable',
          executionTarget: 'remote',
          providerMode: 'noumena_managed',
          renewable: false,
          renewalOwner: 'none',
          organizationUuid: 'org-remote',
          metadata: {
            tokenTransport: 'legacy_oauth_env',
            accessTokenEnvVarName: 'CLAUDE_CODE_OAUTH_TOKEN',
          },
        } as never,
      }),
    ).toMatchObject({
      NOUMENA_BASE_URL: 'https://code.dev.noumena.test',
      NOUMENA_MODEL: 'opus',
      NCODE_REMOTE_RUNTIME_PROVIDER_MODE: 'noumena_managed',
      NCODE_REMOTE_RUNTIME_TOKEN_TRANSPORT: 'legacy_oauth_env',
      CLAUDE_CODE_OAUTH_TOKEN: 'managed-access-token',
    })
  })
})

describe('getRemoteSessionRuntimeForRuntimeLease', () => {
  it('builds noumena-managed runtime with legacy oauth transport', () => {
    const runtimeLease = {
      accessToken: 'tok',
      orgUUID: 'org-1',
      session: {} as never,
      lease: {
        providerMode: 'noumena_managed',
        metadata: { tokenTransport: 'legacy_oauth_env' },
      } as never,
    }
    expect(getRemoteSessionRuntimeForRuntimeLease(runtimeLease)).toEqual({
      kind: 'ncode_remote',
      provider_mode: 'noumena_managed',
      token_transport: 'legacy_oauth_env',
    })
  })

  it('builds BYOK runtime with static api key transport', () => {
    const runtimeLease = {
      accessToken: 'tok',
      orgUUID: 'org-1',
      session: {} as never,
      lease: {
        providerMode: 'byok',
        metadata: { tokenTransport: 'static_api_key_env' },
      } as never,
    }
    expect(getRemoteSessionRuntimeForRuntimeLease(runtimeLease)).toEqual({
      kind: 'ncode_remote',
      provider_mode: 'byok',
      token_transport: 'static_api_key_env',
    })
  })

  it('defaults token_transport to legacy_oauth_env when metadata omits it', () => {
    const runtimeLease = {
      accessToken: 'tok',
      orgUUID: 'org-1',
      session: {} as never,
      lease: {
        providerMode: 'noumena_managed',
        metadata: {},
      } as never,
    }
    expect(
      getRemoteSessionRuntimeForRuntimeLease(runtimeLease).token_transport,
    ).toBe('legacy_oauth_env')
  })

  it('allows overriding the runtime kind', () => {
    const runtimeLease = {
      accessToken: 'tok',
      orgUUID: 'org-1',
      session: {} as never,
      lease: {
        providerMode: 'noumena_managed',
        metadata: {},
      } as never,
    }
    expect(
      getRemoteSessionRuntimeForRuntimeLease(runtimeLease, 'codex_app_server'),
    ).toEqual({
      kind: 'codex_app_server',
      provider_mode: 'noumena_managed',
      token_transport: 'legacy_oauth_env',
    })
  })
})

describe('redactRemoteSessionEnvironmentVariables', () => {
  it('redacts keys containing TOKEN', () => {
    expect(
      redactRemoteSessionEnvironmentVariables({
        CLAUDE_CODE_OAUTH_TOKEN: 'secret',
        SAFE_VAR: 'visible',
      }),
    ).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: '<redacted>',
      SAFE_VAR: 'visible',
    })
  })

  it('redacts keys containing KEY, SECRET, and PASSWORD', () => {
    expect(
      redactRemoteSessionEnvironmentVariables({
        API_KEY: 'k',
        MY_SECRET: 's',
        USER_PASSWORD: 'p',
        PUBLIC: 'ok',
      }),
    ).toEqual({
      API_KEY: '<redacted>',
      MY_SECRET: '<redacted>',
      USER_PASSWORD: '<redacted>',
      PUBLIC: 'ok',
    })
  })

  it('preserves values for non-sensitive keys', () => {
    expect(
      redactRemoteSessionEnvironmentVariables({
        NOUMENA_BASE_URL: 'https://api.noumena.com',
        NOUMENA_MODEL: 'opus',
      }),
    ).toEqual({
      NOUMENA_BASE_URL: 'https://api.noumena.com',
      NOUMENA_MODEL: 'opus',
    })
  })

  it('handles an empty env record', () => {
    expect(redactRemoteSessionEnvironmentVariables({})).toEqual({})
  })
})
