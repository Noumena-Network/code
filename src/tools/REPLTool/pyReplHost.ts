function normalizeEnvPath(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function resolvePythonReplHostExecutableFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return (
    normalizeEnvPath(env.NCODE_PY_REPL_HOST_PATH) ??
    normalizeEnvPath(env.CLAUDE_CODE_PY_REPL_HOST_PATH)
  )
}

export function resolvePythonReplHostExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolvePythonReplHostExecutableFromEnv(env)
}

// The bundled py_repl host previously lived under code/rust/py_repl_host and
// depended on codex/ sources outside the standalone code/ export. Keep the
// supported runtime contract explicit: packaging may provide a host through
// NCODE_PY_REPL_HOST_PATH, otherwise py_repl remains unavailable.
