import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { PassThrough } from 'stream'
import { type FrameEvent } from './frame.js'
import instances from './instances.js'
import { createRoot, type Root } from './root.js'
import { AlternateScreen } from './components/AlternateScreen.js'
import Box from './components/Box.js'
import Text from './components/Text.js'
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from './termio/dec.js'
import { CURSOR_HOME } from './termio/csi.js'

type FakeInput = PassThrough &
  NodeJS.ReadStream & {
    isTTY: boolean
    isRaw: boolean
    setRawMode: (raw: boolean) => void
    ref: () => FakeInput
    unref: () => FakeInput
  }

type FakeOutput = PassThrough &
  NodeJS.WriteStream & {
    isTTY: boolean
    columns: number
    rows: number
    getWindowSize: () => [number, number]
  }

type FakeTerminal = {
  stdin: FakeInput
  stdout: FakeOutput
  stderr: FakeOutput
  clearOutput: () => void
  getOutput: () => string
  getChunks: () => string[]
}

type InkRecoveryInstance = {
  enterAlternateScreen: () => void
  exitAlternateScreen: () => void
  forceRedraw: (options?: {
    clearBeforePaint?: boolean
    forceHomeRepaint?: boolean
  }) => void
  reassertTerminalModes: (includeAltScreen?: boolean) => void
  handleResume: () => void
  displayCursor: { x: number; y: number } | null
}

let liveRoot: Root | null = null

afterEach(async () => {
  if (liveRoot) {
    liveRoot.unmount()
    liveRoot = null
  }
  await Bun.sleep(0)
})

function createFakeInput(): FakeInput {
  const stdin = new PassThrough() as FakeInput
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = (raw: boolean) => {
    stdin.isRaw = raw
  }
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return stdin
}

function createFakeOutput(columns: number, rows: number): FakeOutput {
  const stdout = new PassThrough() as FakeOutput
  stdout.isTTY = true
  stdout.columns = columns
  stdout.rows = rows
  stdout.getWindowSize = () => [columns, rows]
  return stdout
}

function createFakeTerminal(columns = 40, rows = 12): FakeTerminal {
  let output = ''
  let chunks: string[] = []
  const stdout = createFakeOutput(columns, rows)
  const stderr = createFakeOutput(columns, rows)
  stdout.on('data', chunk => {
    const text = chunk.toString()
    output += text
    chunks.push(text)
  })
  return {
    stdin: createFakeInput(),
    stdout,
    stderr,
    clearOutput: () => {
      output = ''
      chunks = []
    },
    getOutput: () => output,
    getChunks: () => [...chunks],
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(message)
}

function RecoveryHarness(): React.ReactNode {
  return (
    <AlternateScreen mouseTracking={true}>
      <Text>recovery-body</Text>
    </AlternateScreen>
  )
}

function MainScreenRecoveryHarness(): React.ReactNode {
  return <Text>main-screen-body</Text>
}

function TallMainScreenRecoveryHarness(): React.ReactNode {
  return (
    <Box flexDirection="column">
      {Array.from({ length: 8 }, (_, index) => (
        <Text key={index}>main-row-{index}</Text>
      ))}
    </Box>
  )
}

describe('Ink alt-screen recovery behavior', () => {
  it('reasserts alt-screen mode without an out-of-band clear or immediate repaint', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<RecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first alt-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    const frameCount = frames.length

    terminal.clearOutput()
    ink.reassertTerminalModes(true)
    await Bun.sleep(20)

    const output = terminal.getOutput()
    expect(output.includes(ENTER_ALT_SCREEN + CURSOR_HOME)).toBe(true)
    expect(output.includes('\u001b[2J')).toBe(false)
    expect(output.includes('\u001b[3J')).toBe(false)
    expect(frames.length).toBe(frameCount)
  })

  it('fullscreen editor return starts with alt-screen re-entry instead of an out-of-band clear', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<RecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first alt-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    ink.enterAlternateScreen()
    terminal.clearOutput()
    const frameCount = frames.length

    ink.exitAlternateScreen()

    await waitFor(
      () => frames.length > frameCount && terminal.getChunks().length > 0,
      'fullscreen editor return never produced a resumed alt-screen frame',
    )

    const chunks = terminal.getChunks()
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]?.includes(ENTER_ALT_SCREEN + CURSOR_HOME)).toBe(true)
    expect(chunks[0]?.includes('\u001b[2J')).toBe(false)
    expect(chunks[0]?.includes('\u001b[3J')).toBe(false)
    expect(terminal.getOutput().includes('\u001b[3J')).toBe(false)
  })

  it('main-screen editor return exits alt-screen without an out-of-band clear before repaint', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<MainScreenRecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first main-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    ink.enterAlternateScreen()
    await Bun.sleep(20)
    terminal.clearOutput()
    const frameCount = frames.length

    ink.exitAlternateScreen()

    await waitFor(
      () => frames.length > frameCount && terminal.getChunks().length > 0,
      'main-screen editor return never produced a resumed frame',
    )

    const chunks = terminal.getChunks()
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]?.includes(EXIT_ALT_SCREEN)).toBe(true)
    expect(chunks[0]?.includes(ENTER_ALT_SCREEN)).toBe(false)
    expect(chunks[0]?.includes('\u001b[2J')).toBe(false)
    expect(chunks[0]?.includes('\u001b[3J')).toBe(false)
  })

  it('main-screen SIGCONT recovery repaints immediately without an out-of-band clear', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<MainScreenRecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first main-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    const frameCount = frames.length
    terminal.clearOutput()

    ink.handleResume()

    await waitFor(
      () => frames.length > frameCount && terminal.getChunks().length > 0,
      'main-screen SIGCONT recovery never produced an immediate repaired frame',
    )

    const chunks = terminal.getChunks()
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]?.includes('main-screen-body')).toBe(true)
    expect(chunks[0]?.includes(CURSOR_HOME)).toBe(false)
    expect(chunks[0]?.includes(ENTER_ALT_SCREEN)).toBe(false)
    expect(chunks[0]?.includes(EXIT_ALT_SCREEN)).toBe(false)
    expect(chunks[0]?.includes('\u001b[2J')).toBe(false)
    expect(chunks[0]?.includes('\u001b[3J')).toBe(false)
  })

  it('main-screen stdin-gap recovery reasserts modes without repainting the viewport', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<MainScreenRecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first main-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    const frameCount = frames.length
    terminal.clearOutput()

    ink.reassertTerminalModes()

    const output = terminal.getOutput()
    expect(frames.length).toBe(frameCount)
    expect(output.includes(CURSOR_HOME)).toBe(false)
    expect(output.includes(ENTER_ALT_SCREEN)).toBe(false)
    expect(output.includes(EXIT_ALT_SCREEN)).toBe(false)
    expect(output.includes('\u001b[2J')).toBe(false)
    expect(output.includes('\u001b[3J')).toBe(false)
  })

  it('main-screen forceRedraw repaints immediately without an out-of-band clear', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<MainScreenRecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first main-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    const frameCount = frames.length
    terminal.clearOutput()

    ink.forceRedraw()

    await waitFor(
      () => frames.length > frameCount && terminal.getChunks().length > 0,
      'main-screen forceRedraw never produced an immediate repaired frame',
    )

    const output = terminal.getOutput()
    expect(output.includes('main-screen-body')).toBe(true)
    expect(output.includes(CURSOR_HOME)).toBe(false)
    expect(output.includes(ENTER_ALT_SCREEN)).toBe(false)
    expect(output.includes(EXIT_ALT_SCREEN)).toBe(false)
    expect(output.includes('\u001b[2J')).toBe(false)
    expect(output.includes('\u001b[3J')).toBe(false)
  })

  it('main-screen compact forceRedraw clears visible viewport before repainting', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<MainScreenRecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first main-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    const frameCount = frames.length
    ink.displayCursor = { x: 5, y: 0 }
    terminal.clearOutput()

    ink.forceRedraw({ clearBeforePaint: true })

    await waitFor(
      () => frames.length > frameCount && terminal.getChunks().length > 0,
      'main-screen compact forceRedraw never produced an immediate repaired frame',
    )

    const output = terminal.getOutput()
    expect(output.startsWith('\u001b[2J\u001b[H')).toBe(true)
    expect(output.includes('main-screen-body')).toBe(true)
    expect(output.includes(ENTER_ALT_SCREEN)).toBe(false)
    expect(output.includes(EXIT_ALT_SCREEN)).toBe(false)
    expect(output.includes('\u001b[3J')).toBe(false)
  })

  it('main-screen compact forceRedraw repaints only the visible suffix for scrollback-sized output', async () => {
    const terminal = createFakeTerminal(40, 5)
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<TallMainScreenRecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first tall main-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    const frameCount = frames.length
    terminal.clearOutput()

    ink.forceRedraw({ clearBeforePaint: true })

    await waitFor(
      () => frames.length > frameCount && terminal.getChunks().length > 0,
      'main-screen tall compact forceRedraw never produced an immediate repaired frame',
    )

    const output = terminal.getOutput()
    expect(output.startsWith('\u001b[2J\u001b[H')).toBe(true)
    expect(output.includes('main-row-0')).toBe(false)
    expect(output.includes('main-row-1')).toBe(false)
    expect(output.includes('main-row-2')).toBe(false)
    expect(output.includes('main-row-3')).toBe(false)
    expect(output.includes('main-row-4')).toBe(true)
    expect(output.includes('main-row-7')).toBe(true)
    expect(output.includes(ENTER_ALT_SCREEN)).toBe(false)
    expect(output.includes(EXIT_ALT_SCREEN)).toBe(false)
    expect(output.includes('\u001b[3J')).toBe(false)
  })

  it('main-screen forceRedraw with forceHomeRepaint clears viewport remainder on short output without pushing scrollback', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<MainScreenRecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first main-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    let frameCount = frames.length
    terminal.clearOutput()

    ink.forceRedraw({ forceHomeRepaint: true })

    await waitFor(
      () => frames.length > frameCount && terminal.getChunks().length > 0,
      'first forceHomeRepaint never produced an immediate repaired frame',
    )

    const firstOutput = terminal.getOutput()
    expect(firstOutput.includes('main-screen-body')).toBe(true)
    expect(firstOutput.includes('\u001b[J')).toBe(true)
    expect(firstOutput.includes('\u001b[2J')).toBe(false)
    expect(firstOutput.includes('\u001b[3J')).toBe(false)

    frameCount = frames.length
    terminal.clearOutput()

    ink.forceRedraw({ forceHomeRepaint: true })

    await waitFor(
      () => frames.length > frameCount && terminal.getChunks().length > 0,
      'second forceHomeRepaint never produced an immediate repaired frame',
    )

    const secondOutput = terminal.getOutput()
    const matches = secondOutput.match(/main-screen-body/g) ?? []
    expect(matches.length).toBe(1)
    expect(secondOutput.includes('\u001b[J')).toBe(true)
    expect(secondOutput.includes('\u001b[2J')).toBe(false)
    expect(secondOutput.includes('\u001b[3J')).toBe(false)
  })

  it('alt-screen forceRedraw repaints in-place without an out-of-band clear or alt re-entry', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<RecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first alt-screen frame',
    )

    const ink = instances.get(terminal.stdout)! as unknown as InkRecoveryInstance
    const frameCount = frames.length
    terminal.clearOutput()

    ink.forceRedraw()

    await waitFor(
      () => frames.length > frameCount && terminal.getChunks().length > 0,
      'alt-screen forceRedraw never produced a repaired frame',
    )

    const chunks = terminal.getChunks()
    expect(chunks.length).toBeGreaterThan(0)
    expect(terminal.getOutput().includes(ENTER_ALT_SCREEN)).toBe(false)
    expect(chunks[0]?.includes('\u001b[2J')).toBe(false)
    expect(chunks[0]?.includes('\u001b[3J')).toBe(false)
    expect(terminal.getOutput().includes(EXIT_ALT_SCREEN)).toBe(false)
  })

  it('stray stderr in alt-screen only poisons for repaint and never emits clear or alt toggles', async () => {
    const terminal = createFakeTerminal()
    const frames: FrameEvent[] = []

    liveRoot = await createRoot({
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      stderr: terminal.stderr,
      exitOnCtrlC: false,
      patchConsole: true,
      onFrame: event => {
        frames.push(event)
      },
    })

    liveRoot.render(<RecoveryHarness />)

    await waitFor(
      () => instances.get(terminal.stdout) !== undefined && frames.length > 0,
      'mounted Ink root never reached the first alt-screen frame',
    )

    terminal.clearOutput()
    const frameCount = frames.length
    process.stderr.write('ink recovery stderr probe\n')

    await waitFor(
      () => frames.length > frameCount,
      'stderr corruption probe never triggered a repaint',
    )

    const repaintFrames = frames.slice(frameCount)
    expect(repaintFrames.length).toBeGreaterThan(0)
    expect(repaintFrames.every(frame => frame.flickers.length === 0)).toBe(true)

    const output = terminal.getOutput()
    expect(output.includes('\u001b[2J')).toBe(false)
    expect(output.includes('\u001b[3J')).toBe(false)
    expect(output.includes(ENTER_ALT_SCREEN)).toBe(false)
    expect(output.includes(EXIT_ALT_SCREEN)).toBe(false)
  })
})
