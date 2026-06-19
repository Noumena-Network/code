process.env.NCODE_ENABLE_NATIVE_FENCED_CODE = '1'

import { getImageCreator, getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import { resolvePythonReplHostExecutable } from '../tools/REPLTool/pyReplHost.js'
import { ripgrepCommand } from '../utils/ripgrep.js'
import { isInBundledMode, isRunningWithBun } from '../utils/bundledMode.js'
import { renderNativeFencedCode } from '../utils/markdown/nativeFencedCodeRenderer.js'

const audioModule = await import('audio-capture-napi')
if (typeof audioModule.isNativeAudioAvailable !== 'function') {
  throw new Error('audio-capture-napi shim did not expose isNativeAudioAvailable()')
}

const audioAvailable = audioModule.isNativeAudioAvailable()
const audioWarnings = audioAvailable
  ? []
  : ['Native audio capture not available in this package/runtime']

const imageCreator = await getImageCreator()
const capturedWarnings: string[] = []
const originalWarn = console.warn
console.warn = (...args: unknown[]) => {
  capturedWarnings.push(args.map(arg => String(arg)).join(' '))
}

let imageProcessor: Awaited<ReturnType<typeof getImageProcessor>>
try {
  imageProcessor = await getImageProcessor()
} finally {
  console.warn = originalWarn
}

const imageBuffer = await imageCreator({
  create: {
    width: 2,
    height: 2,
    channels: 3,
    background: { r: 255, g: 0, b: 0 },
  },
})
  .png()
  .toBuffer()

const metadata = await imageProcessor(imageBuffer).metadata()
if (metadata.width !== 2 || metadata.height !== 2) {
  throw new Error(`Unexpected sharp metadata result: ${JSON.stringify(metadata)}`)
}

const renderedLines = renderNativeFencedCode('const value = 1', {
  language: 'ts',
  terminalWidth: 80,
})
if (!renderedLines || renderedLines.length === 0) {
  throw new Error('Native fenced code renderer did not produce any lines')
}

const { rgPath, rgArgs } = ripgrepCommand()
const ripgrepVersionProc = Bun.spawn({
  cmd: [rgPath, ...rgArgs, '--version'],
  stderr: 'pipe',
  stdout: 'pipe',
})
const [ripgrepVersionCode, ripgrepVersionStdout, ripgrepVersionStderr] =
  await Promise.all([
    ripgrepVersionProc.exited,
    new Response(ripgrepVersionProc.stdout).text(),
    new Response(ripgrepVersionProc.stderr).text(),
  ])

if (
  ripgrepVersionCode !== 0 ||
  !ripgrepVersionStdout.startsWith('ripgrep ')
) {
  throw new Error(
    `Bundled ripgrep probe failed (code=${ripgrepVersionCode}). stdout=${JSON.stringify(
      ripgrepVersionStdout,
    )} stderr=${JSON.stringify(ripgrepVersionStderr)}`,
  )
}

const ripgrepFilesProc = Bun.spawn({
  cmd: [rgPath, ...rgArgs, '--files', '.'],
  stderr: 'pipe',
  stdout: 'pipe',
})
const [ripgrepFilesCode, ripgrepFilesStdout, ripgrepFilesStderr] =
  await Promise.all([
    ripgrepFilesProc.exited,
    new Response(ripgrepFilesProc.stdout).text(),
    new Response(ripgrepFilesProc.stderr).text(),
  ])

const ripgrepFilesCount = ripgrepFilesStdout
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean).length

if (ripgrepFilesCode !== 0 || ripgrepFilesCount === 0) {
  throw new Error(
    `Bundled ripgrep file listing failed (code=${ripgrepFilesCode}, files=${ripgrepFilesCount}). stdout=${JSON.stringify(
      ripgrepFilesStdout,
    )} stderr=${JSON.stringify(ripgrepFilesStderr)}`,
  )
}

const pyReplHostPath = resolvePythonReplHostExecutable()
let pyReplHostCode: number | null = null
if (pyReplHostPath) {
  const pyReplHostProbe = Bun.spawn({
    cmd: [pyReplHostPath],
    stdin: 'ignore',
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [code, pyReplHostStdout, pyReplHostStderr] = await Promise.all([
    pyReplHostProbe.exited,
    new Response(pyReplHostProbe.stdout).text(),
    new Response(pyReplHostProbe.stderr).text(),
  ])
  pyReplHostCode = code

  if (pyReplHostCode !== 0) {
    throw new Error(
      `Configured py_repl host probe failed (code=${pyReplHostCode}). stdout=${JSON.stringify(
        pyReplHostStdout,
      )} stderr=${JSON.stringify(pyReplHostStderr)}`,
    )
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      bundledMode: isInBundledMode(),
      runningWithBun: isRunningWithBun(),
      execPath: process.execPath,
      argv1: process.argv[1] || null,
      audioAvailable,
      audioWarnings,
      imageProcessorMode:
        capturedWarnings.length > 0 ? 'sharp-fallback' : 'native',
      imageProcessorWarnings: capturedWarnings,
      imageBytes: imageBuffer.length,
      metadata,
      renderedLines: renderedLines.length,
      ripgrep: {
        path: rgPath,
        version: ripgrepVersionStdout.trim(),
        filesCount: ripgrepFilesCount,
      },
      pyReplHost: {
        path: pyReplHostPath,
        status: pyReplHostPath ? 'configured' : 'not-configured',
        exitCode: pyReplHostCode,
      },
    },
    null,
    2,
  ),
)
