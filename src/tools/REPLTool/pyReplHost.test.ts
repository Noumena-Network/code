import { describe, expect, it } from 'bun:test'
import {
  resolvePythonReplHostExecutable,
  resolvePythonReplHostExecutableFromEnv,
} from './pyReplHost.js'

describe('py_repl rust host resolution', () => {
  it('prefers the NCode env var', () => {
    expect(
      resolvePythonReplHostExecutableFromEnv({
        NCODE_PY_REPL_HOST_PATH: '/tmp/ncode-py-repl-host',
        CLAUDE_CODE_PY_REPL_HOST_PATH: '/tmp/legacy-host',
      }),
    ).toBe('/tmp/ncode-py-repl-host')
  })

  it('falls back to the legacy alias only for compatibility', () => {
    expect(
      resolvePythonReplHostExecutableFromEnv({
        CLAUDE_CODE_PY_REPL_HOST_PATH: '/tmp/legacy-host',
      }),
    ).toBe('/tmp/legacy-host')
  })

  it('treats empty values as absent', () => {
    expect(
      resolvePythonReplHostExecutableFromEnv({
        NCODE_PY_REPL_HOST_PATH: '   ',
        CLAUDE_CODE_PY_REPL_HOST_PATH: '',
      }),
    ).toBeNull()
  })

  it('returns null when no host path is configured', () => {
    expect(resolvePythonReplHostExecutable({})).toBeNull()
  })

  it('uses the env override as the only active host source', () => {
    expect(
      resolvePythonReplHostExecutable({
        NCODE_PY_REPL_HOST_PATH: '/tmp/ncode-py-repl-host',
      }),
    ).toBe('/tmp/ncode-py-repl-host')
  })
})
