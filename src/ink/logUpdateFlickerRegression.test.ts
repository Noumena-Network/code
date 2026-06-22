import type { AnsiCode } from '@alcalzone/ansi-tokenize'
import { describe, expect, it } from 'bun:test'
import type { Diff, Frame } from './frame.js'
import { LogUpdate } from './log-update.js'
import type { Terminal } from './terminal.js'
import { writeDiffToTerminal } from './terminal.js'
import { getResetSequenceForReason } from './clearTerminal.js'
import {
  getLogUpdateRenderStatsSnapshot,
  resetLogUpdateRenderStatsForTesting,
} from './logUpdateRenderStats.js'
import { BSU, ESU } from './termio/dec.js'
import {
  eraseToEndOfScreen,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
} from './termio/csi.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from './screen.js'

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

function withNoTmuxEnv<T>(fn: () => T): T {
  const previousTmux = process.env.TMUX
  delete process.env.TMUX
  try {
    return fn()
  } finally {
    if (previousTmux !== undefined) {
      process.env.TMUX = previousTmux
    }
  }
}

function withSupportedSyncEnv<T>(fn: () => T): T {
  const previousTmux = process.env.TMUX
  const previousTermProgram = process.env.TERM_PROGRAM
  const previousTerm = process.env.TERM
  delete process.env.TMUX
  process.env.TERM_PROGRAM = 'WezTerm'
  process.env.TERM = 'wezterm'
  try {
    return fn()
  } finally {
    if (previousTmux === undefined) {
      delete process.env.TMUX
    } else {
      process.env.TMUX = previousTmux
    }
    if (previousTermProgram === undefined) {
      delete process.env.TERM_PROGRAM
    } else {
      process.env.TERM_PROGRAM = previousTermProgram
    }
    if (previousTerm === undefined) {
      delete process.env.TERM
    } else {
      process.env.TERM = previousTerm
    }
  }
}

function makeFrame({
  lines,
  viewportWidth = 10,
  viewportHeight,
  screenHeight = lines.length,
  cursorY = screenHeight,
  cells = [],
}: {
  lines: string[]
  viewportWidth?: number
  viewportHeight: number
  screenHeight?: number
  cursorY?: number
  cells?: Array<{
    x: number
    y: number
    char: string
    styleId?: number
    width?: CellWidth
  }>
}): Frame {
  const screen = createScreen(
    viewportWidth,
    screenHeight,
    stylePool,
    charPool,
    hyperlinkPool,
  )

  for (let y = 0; y < lines.length; y += 1) {
    const line = lines[y] ?? ''
    for (let x = 0; x < line.length; x += 1) {
      setCellAt(screen, x, y, {
        char: line[x]!,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
  }
  for (const cell of cells) {
    setCellAt(screen, cell.x, cell.y, {
      char: cell.char,
      styleId: cell.styleId ?? stylePool.none,
      width: cell.width ?? CellWidth.Narrow,
      hyperlink: undefined,
    })
  }

  return {
    screen,
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
    },
    cursor: {
      x: 0,
      y: cursorY,
      visible: true,
    },
  }
}

function makeStyledLineFrame({
  line,
  styleId,
  viewportWidth = 80,
  viewportHeight = 10,
}: {
  line: string
  styleId: number
  viewportWidth?: number
  viewportHeight?: number
}): Frame {
  const screen = createScreen(
    viewportWidth,
    1,
    stylePool,
    charPool,
    hyperlinkPool,
  )

  for (let x = 0; x < line.length; x += 1) {
    setCellAt(screen, x, 0, {
      char: line[x]!,
      styleId,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    })
  }

  return {
    screen,
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
    },
    cursor: {
      x: 0,
      y: 1,
      visible: true,
    },
  }
}

function findClearTerminalPatch(diff: Diff) {
  return diff.find(
    (
      patch,
    ): patch is Extract<Diff[number], { type: 'clearTerminal' }> =>
      patch.type === 'clearTerminal',
  )
}

function serializeDiff(diff: Diff | { diff: Diff }, skipSyncMarkers = true): string {
  const patches = Array.isArray(diff) ? diff : diff.diff
  let written = ''
  const terminal = {
    stdout: {
      write(chunk: string) {
        written += chunk
        return true
      },
    },
    stderr: {
      write() {
        return true
      },
    },
  } as unknown as Terminal

  withNoTmuxEnv(() => {
    writeDiffToTerminal(terminal, patches, skipSyncMarkers)
  })
  return written
}

function runTransition(
  prev: Frame,
  next: Frame,
  skipSyncMarkers = true,
): {
  diff: Diff
  written: string
  clearPatch: Extract<Diff[number], { type: 'clearTerminal' }> | undefined
} {
  const { diff } = new LogUpdate({ isTTY: true, stylePool }).render(prev, next)
  return {
    diff,
    written: serializeDiff(diff, skipSyncMarkers),
    clearPatch: findClearTerminalPatch(diff),
  }
}

function runTransitionWithLog(
  log: LogUpdate,
  prev: Frame,
  next: Frame,
  skipSyncMarkers = true,
): {
  diff: Diff
  written: string
  clearPatch: Extract<Diff[number], { type: 'clearTerminal' }> | undefined
} {
  const { diff } = log.render(prev, next)
  return {
    diff,
    written: serializeDiff(diff, skipSyncMarkers),
    clearPatch: findClearTerminalPatch(diff),
  }
}

describe('LogUpdate flicker regressions', () => {
  it('returns the physical frame for ordinary incremental renders', () => {
    const prev = makeFrame({
      lines: ['old'],
      viewportHeight: 5,
    })
    const next = makeFrame({
      lines: ['new'],
      viewportHeight: 5,
    })

    const result = new LogUpdate({ isTTY: true, stylePool }).render(prev, next)

    expect(result.physicalFrame).toBe(next)
    expect(result.diff.length).toBeGreaterThan(0)
  })

  it('clips physicalFrame to visible rows for tall logical main-screen frames', () => {
    const prev = makeFrame({
      lines: Array.from({ length: 20 }, (_, i) => `row-${i}`),
      viewportWidth: 10,
      viewportHeight: 6,
      screenHeight: 20,
      cursorY: 20,
    })
    const next = makeFrame({
      lines: Array.from({ length: 20 }, (_, i) => `row-${i}${i === 19 ? '-changed' : ''}`),
      viewportWidth: 10,
      viewportHeight: 6,
      screenHeight: 20,
      cursorY: 20,
    })
    const result = new LogUpdate({ isTTY: true, stylePool }).render(prev, next)
    expect(result.physicalFrame.screen.height).toBe(5) // viewport.height - 1
    expect(result.physicalFrame.cursor.y).toBe(5) // 20 - 15 = 5
  })

  it('skips redundant incremental moveCursor calls when the diff already starts at the live cursor', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: [''],
      viewportWidth: 10,
      viewportHeight: 1,
      cursorY: 0,
    })
    const next = makeFrame({
      lines: ['a'],
      viewportWidth: 10,
      viewportHeight: 1,
      cursorY: 0,
    })

    const result = runTransition(prev, next)
    const stats = getLogUpdateRenderStatsSnapshot()

    expect(result.clearPatch).toBeUndefined()
    expect(result.written).toContain('a')
    expect(stats.totalNoopMoveCursorCalls).toBe(0)
    expect(stats.totalMoveCursorCalls).toBe(1)
    expect(stats.totalSameLineMoveCursorCalls).toBe(1)
    expect(stats.lastIncrementalDiffDurationMs).toBeGreaterThan(0)
    expect(stats.lastIncrementalDiffCallbackDurationMs).toBeGreaterThan(0)
  })

  it('repaints plain same-line gaps as inline spaces instead of cursor hops', () => {
    resetLogUpdateRenderStatsForTesting()
    const next = makeFrame({
      lines: ['a b c'],
      viewportWidth: 10,
      viewportHeight: 1,
      cursorY: 0,
    })
    const log = new LogUpdate({ isTTY: true, stylePool })

    const diff = log.renderFullRepaintFromHome(next)
    const written = serializeDiff(diff)
    const stats = getLogUpdateRenderStatsSnapshot()

    expect(written.startsWith('\u001b[H')).toBe(true)
    expect(written).toContain('a b c')
    expect(diff.diff.some(patch => patch.type === 'cursorMove')).toBe(false)
    expect(stats.totalSameLineMoveCursorCalls).toBe(0)
    expect(stats.totalBufferedGapFillCalls).toBeGreaterThan(0)
    expect(stats.totalBufferedGapFillCells).toBeGreaterThan(0)
  })

  it('fills incremental same-line gaps inline when unchanged gaps are plain written spaces', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['foo  x'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 1,
    })
    const next = makeFrame({
      lines: ['bar  y'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 1,
    })

    runTransition(prev, next)
    const stats = getLogUpdateRenderStatsSnapshot()

    expect(stats.totalSameLineMoveCursorCalls).toBe(0)
    expect(stats.totalIncrementalGapFillCandidateCalls).toBeGreaterThan(0)
    expect(stats.totalIncrementalGapFillCandidateCells).toBeGreaterThan(0)
    expect(stats.totalBufferedGapFillCalls).toBeGreaterThan(0)
    expect(stats.totalBufferedGapFillCells).toBeGreaterThan(0)
  })

  it('fills incremental same-line gaps inline for fg-only spaces that already match the current style', () => {
    resetLogUpdateRenderStatsForTesting()
    const redStyle = stylePool.intern([
      {
        code: '\u001b[31m',
        endCode: '\u001b[39m',
      } satisfies AnsiCode,
    ])
    const prev = makeFrame({
      lines: ['f  x'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 1,
      cells: [
        { x: 0, y: 0, char: 'f', styleId: redStyle },
        { x: 1, y: 0, char: ' ', styleId: redStyle },
        { x: 2, y: 0, char: ' ', styleId: redStyle },
        { x: 3, y: 0, char: 'x', styleId: redStyle },
      ],
    })
    const next = makeFrame({
      lines: ['a  y'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 1,
      cells: [
        { x: 0, y: 0, char: 'a', styleId: redStyle },
        { x: 1, y: 0, char: ' ', styleId: redStyle },
        { x: 2, y: 0, char: ' ', styleId: redStyle },
        { x: 3, y: 0, char: 'y', styleId: redStyle },
      ],
    })

    runTransition(prev, next)
    const stats = getLogUpdateRenderStatsSnapshot()

    expect(stats.totalSameLineMoveCursorCalls).toBe(0)
    expect(stats.totalIncrementalGapFillCandidateCalls).toBeGreaterThan(0)
    expect(stats.totalIncrementalGapFillCandidateCells).toBeGreaterThan(0)
    expect(stats.totalBufferedGapFillCalls).toBeGreaterThan(0)
    expect(stats.totalBufferedGapFillCells).toBeGreaterThan(0)
  })

  it('records partial same-line gap opportunities when a visible cell blocks the rest of the gap', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['foo Bx'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 1,
    })
    const next = makeFrame({
      lines: ['bar By'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 1,
    })

    runTransition(prev, next)

    const stats = getLogUpdateRenderStatsSnapshot()
    expect(stats.totalSameLineMoveCursorCalls).toBeGreaterThan(0)
    expect(stats.totalGapAnalysisCalls).toBeGreaterThan(0)
    expect(stats.totalPartialGapFillCandidateCalls).toBeGreaterThan(0)
    expect(stats.totalPartialGapFillCandidateCells).toBeGreaterThan(0)
    expect(stats.totalGapBlockedByNonSpaceChar).toBeGreaterThan(0)
  })

  it('fills next-row leading spaces inline instead of using a next-row offset cursor move', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['foo', '  x'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 2,
    })
    const next = makeFrame({
      lines: ['bar', '  y'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 2,
    })

    runTransition(prev, next)

    const stats = getLogUpdateRenderStatsSnapshot()
    expect(stats.totalBufferedNextRowPrefixFillCalls).toBeGreaterThan(0)
    expect(stats.totalBufferedNextRowPrefixFillCells).toBeGreaterThan(0)
    expect(stats.totalLineChangeNextRowOffsetCalls).toBe(0)
  })

  it('spends a partial next-row prefix before the remaining offset move', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['foo', '  Ax'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 2,
    })
    const next = makeFrame({
      lines: ['bar', '  Ay'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 2,
    })

    const { written } = runTransition(prev, next)
    const stats = getLogUpdateRenderStatsSnapshot()

    expect(stats.totalNextRowPrefixPartialGapFillCandidateCalls).toBeGreaterThan(0)
    expect(stats.totalNextRowPrefixPartialGapFillCandidateCells).toBeGreaterThan(0)
    expect(stats.totalBufferedNextRowPrefixFillCalls).toBeGreaterThan(0)
    expect(stats.totalBufferedNextRowPrefixFillCells).toBeGreaterThan(0)
    expect(written).toContain('\r\n  \u001b[1C')
    expect(written).not.toContain('\r\n\u001b[3C')
  })

  it('moves to next-row home with a newline instead of a cursor-move escape', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['keep', ''],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 0,
    })
    const next = makeFrame({
      lines: ['keep', 'row'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 1,
    })

    const { written } = runTransition(prev, next)

    const stats = getLogUpdateRenderStatsSnapshot()
    expect(stats.totalLineChangeNextRowHomeCalls).toBeGreaterThan(0)
    expect(written).toContain('\r\nrow')
    expect(written).not.toContain('\u001B[1B')
  })

  it('uses CR+LF plus horizontal move for content-end next-row offset fallback', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['foo', '  '],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 1,
      cells: [{ x: 3, y: 1, char: 'x' }],
    })
    const next = makeFrame({
      lines: ['bar', '  '],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 2,
    })

    const { written } = runTransition(prev, next)
    const stats = getLogUpdateRenderStatsSnapshot()

    expect(stats.totalNextRowPrefixBlockedByContentEnd).toBeGreaterThan(0)
    expect(written).toContain('\r\n\u001b[3C')
    expect(written).not.toContain('\u001B[1B')
  })

  it('uses CR+LF plus horizontal move for generic next-row offset moves blocked by visible prefix content', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['keep', ' ax'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 0,
    })
    const next = makeFrame({
      lines: ['keep', ' ay'],
      viewportWidth: 20,
      viewportHeight: 4,
      cursorY: 2,
    })

    const { written } = runTransition(prev, next)
    const stats = getLogUpdateRenderStatsSnapshot()

    expect(stats.totalNextRowPrefixBlockedByNonSpaceChar).toBeGreaterThan(0)
    expect(stats.totalLineChangeNextRowOffsetCalls).toBeGreaterThan(0)
    expect(written).toContain('\r\n \u001b[1C')
    expect(written).not.toContain('\r\n\u001b[2C')
    expect(written).not.toContain('\u001B[1B')
  })

  it('clears incremental row tails with erase-to-end-of-line once the next row ends', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['foo trailing text'],
      viewportWidth: 24,
      viewportHeight: 4,
      cursorY: 1,
    })
    const next = makeFrame({
      lines: ['bar'],
      viewportWidth: 24,
      viewportHeight: 4,
      cursorY: 1,
    })

    runTransition(prev, next)
    const stats = getLogUpdateRenderStatsSnapshot()

    expect(stats.totalIncrementalTailClearShortcutCalls).toBeGreaterThan(0)
  })

  it('clears an empty next row tail from home instead of paying a next-row offset move', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['foo', 'stale trailing text'],
      viewportWidth: 24,
      viewportHeight: 4,
      cursorY: 2,
    })
    const next = makeFrame({
      lines: ['bar', ''],
      viewportWidth: 24,
      viewportHeight: 4,
      cursorY: 2,
    })

    runTransition(prev, next)

    const stats = getLogUpdateRenderStatsSnapshot()
    expect(stats.totalIncrementalTailClearShortcutCalls).toBeGreaterThan(0)
    expect(stats.totalLineChangeNextRowOffsetCalls).toBe(0)
  })

  it('clears an empty next row tail from pending-wrap state instead of paying a next-row offset move', () => {
    resetLogUpdateRenderStatsForTesting()
    const prev = makeFrame({
      lines: ['foo', 'stale trailing text'],
      viewportWidth: 24,
      viewportHeight: 4,
      cursorY: 0,
    })
    prev.cursor.x = prev.viewport.width

    const next = makeFrame({
      lines: ['foo', ''],
      viewportWidth: 24,
      viewportHeight: 4,
      cursorY: 2,
    })

    runTransition(prev, next)

    const stats = getLogUpdateRenderStatsSnapshot()
    expect(stats.totalIncrementalTailClearShortcutCalls).toBeGreaterThan(0)
    expect(stats.totalLineChangeNextRowOffsetCalls).toBe(0)
  })

  it('stays fully incremental for safe height-only shrinks', () => {
    const lines = Array.from({ length: 10 }, (_, index) => String(index))
    const prev = makeFrame({
      lines,
      viewportWidth: 80,
      viewportHeight: 40,
      cursorY: 10,
    })
    const next = makeFrame({
      lines,
      viewportWidth: 80,
      viewportHeight: 20,
      cursorY: 10,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written).toBe('')
  })

  it('stays incremental when a height-only shrink leaves content exactly fitting the new viewport', () => {
    const lines = Array.from({ length: 6 }, (_, index) => String(index))
    const prev = makeFrame({
      lines,
      viewportWidth: 80,
      viewportHeight: 12,
      cursorY: 5,
    })
    const next = makeFrame({
      lines,
      viewportWidth: 80,
      viewportHeight: 6,
      cursorY: 5,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written).toBe('')
  })

  it('repaints from the previous output origin when height-only shrink clips structural rows', () => {
    const visibleRows = Array.from({ length: 10 }, (_, index) => String(index))
    const prev = makeFrame({
      lines: visibleRows,
      viewportWidth: 10,
      viewportHeight: 40,
      screenHeight: 22,
      cursorY: 10,
    })
    const next = makeFrame({
      lines: visibleRows,
      viewportWidth: 10,
      viewportHeight: 20,
      screenHeight: 10,
      cursorY: 10,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.startsWith('\r')).toBe(true)
    expect(result.written).toContain('0')
    expect(result.written).toContain('9')
    expect(result.written.includes('\u001b[H')).toBe(false)
    expect(result.written.includes('\u001b[2J')).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('stays incremental for width-only shrink when visible content and cursor still fit', () => {
    const prev = makeFrame({
      lines: ['abc'],
      viewportWidth: 10,
      viewportHeight: 10,
    })
    const next = makeFrame({
      lines: ['abc'],
      viewportWidth: 8,
      viewportHeight: 10,
    })

    const result = runTransition(prev, next)

    expect(result.diff).toEqual([])
    expect(result.clearPatch).toBeUndefined()
    expect(result.written).toBe('')
    expect(result.written.includes('\u001b[K')).toBe(false)
    expect(result.written.includes(eraseToEndOfScreen())).toBe(false)
    expect(result.written.includes('\u001b[H')).toBe(false)
    expect(result.written.includes('\u001b[2J')).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('stays incremental for width-only growth when visible content leaves the old right margin', () => {
    const prev = makeFrame({
      lines: ['abc'],
      viewportWidth: 8,
      viewportHeight: 10,
    })
    const next = makeFrame({
      lines: ['abc'],
      viewportWidth: 10,
      viewportHeight: 10,
    })

    const result = runTransition(prev, next)

    expect(result.diff).toEqual([])
    expect(result.clearPatch).toBeUndefined()
    expect(result.written).toBe('')
    expect(result.written.includes('\u001b[H')).toBe(false)
    expect(result.written.includes('\u001b[K')).toBe(false)
    expect(result.written.includes(eraseToEndOfScreen())).toBe(false)
    expect(result.written.includes('\u001b[2J')).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('still clears a repaint row tail when the previous visible row had stale tail content', () => {
    const prev = makeFrame({
      lines: ['abcdefghi'],
      viewportWidth: 10,
      viewportHeight: 10,
    })
    const next = makeFrame({
      lines: ['abc'],
      viewportWidth: 8,
      viewportHeight: 10,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.startsWith('\r')).toBe(true)
    expect(result.written.startsWith('\u001b[H')).toBe(false)
    expect(result.written.includes('\u001b[K')).toBe(true)
    expect(result.written.includes('abc')).toBe(true)
    expect(result.written.includes('\u001b[2J')).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('writes skipped fg-only styled spaces during repaint over stale content', () => {
    const log = new LogUpdate({ isTTY: true, stylePool })
    const dimStyle = stylePool.intern([
      {
        type: 'ansi',
        code: '\u001b[2m',
        endCode: '\u001b[22m',
      },
    ])
    const prev = makeFrame({
      lines: ['Searched for 3epatterns, read 1nfile'],
      viewportWidth: 80,
      viewportHeight: 10,
    })
    const next = makeStyledLineFrame({
      line: 'Searched for 3 patterns, read 1 file',
      styleId: dimStyle,
      viewportWidth: 80,
      viewportHeight: 10,
    })

    const diff = log.renderFullRepaintFromHome(next, prev)
    const written = serializeDiff(diff)

    expect(written).toContain('3 patterns,')
    expect(written).toContain('1 file')
    expect(written).not.toContain('3epatterns')
    expect(written).not.toContain('1nfile')
  })

  it('still clears the lower viewport remainder when a width-change repaint would otherwise leave older visible rows behind', () => {
    const prev = makeFrame({
      lines: ['abc', 'def'],
      viewportWidth: 10,
      viewportHeight: 10,
      cursorY: 2,
    })
    const next = makeFrame({
      lines: ['abc'],
      viewportWidth: 8,
      viewportHeight: 10,
      cursorY: 1,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.startsWith('\r')).toBe(true)
    expect(result.written.startsWith('\u001b[H')).toBe(false)
    expect(result.written.includes(eraseToEndOfScreen())).toBe(true)
    expect(result.written.includes('\u001b[2J')).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('can repaint from home with per-row clears for unsupported alt-screen width changes', () => {
    const log = new LogUpdate({ isTTY: true, stylePool })
    const prev = makeFrame({
      lines: ['OLD-LINE-WIDE', 'SECOND-OLD'],
      viewportWidth: 14,
      viewportHeight: 10,
      cursorY: 2,
    })
    const next = makeFrame({
      lines: ['NEW', 'ROW'],
      viewportWidth: 8,
      viewportHeight: 10,
      cursorY: 2,
    })

    const diff = log.renderFullRepaintFromHome(next, prev, {
      clearRowsBeforeWrite: true,
    })
    const written = serializeDiff(diff)

    expect(written.startsWith('\u001b[H\u001b[K')).toBe(true)
    expect(written.includes('NEW')).toBe(true)
    expect(written.includes('ROW')).toBe(true)
    expect(written.includes('\u001b[2J')).toBe(false)
    expect(written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('can clear the visible viewport before a compact-style repaint from home', () => {
    const log = new LogUpdate({ isTTY: true, stylePool })
    const prev = makeFrame({
      lines: ['OLD1', 'OLD2', 'OLD3'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 3,
    })
    const next = makeFrame({
      lines: ['COMPACT'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 1,
    })

    const diff = log.renderFullRepaintFromHome(next, prev, {
      clearRowsBeforeWrite: true,
      clearViewportBeforeWrite: true,
    })
    const written = serializeDiff(diff)

    expect(written.startsWith('\u001b[2J\u001b[H')).toBe(true)
    expect(written).toContain('COMPACT')
    expect(written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('clips main-screen clear repaint to the visible suffix when scrollback exists', () => {
    const log = new LogUpdate({ isTTY: true, stylePool })
    const prev = makeFrame({
      lines: [
        'OLD-HIDDEN-1',
        'OLD-HIDDEN-2',
        'OLD-VIS-1',
        'OLD-VIS-2',
        'OLD-VIS-3',
        'OLD-VIS-4',
      ],
      viewportWidth: 16,
      viewportHeight: 5,
      cursorY: 6,
    })
    const next = makeFrame({
      lines: ['HIDDEN-1', 'HIDDEN-2', 'VIS-1', 'VIS-2', 'VIS-3', 'VIS-4'],
      viewportWidth: 16,
      viewportHeight: 5,
      cursorY: 6,
    })

    const diff = log.renderMainScreenRepaintFromHome(next, prev, {
      clearRowsBeforeWrite: true,
      clearViewportBeforeWrite: true,
    })
    const written = serializeDiff(diff)

    expect(written.startsWith(ERASE_SCREEN + '\u001b[H')).toBe(true)
    expect(written).not.toContain('HIDDEN-1')
    expect(written).not.toContain('HIDDEN-2')
    expect(written).toContain('VIS-1')
    expect(written).toContain('VIS-4')
    expect(written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('forces eraseToEndOfScreen on identical-dimension main-screen repaints when forceClearViewportRemainder is set', () => {
    // Regression: shouldClearViewportRemainder returns false (empty row-scan
    // range) on identical-dimension main-screen repaints, leaving stale cells
    // below content when React state mutates between renders (e.g. ctrl+l
    // spam). forceClearViewportRemainder overrides and emits ESC[J without
    // ESC[2J that would push content into scrollback.
    const log = new LogUpdate({ isTTY: true, stylePool })
    const prev = makeFrame({
      lines: ['OLD1', 'OLD2'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 2,
    })
    const next = makeFrame({
      lines: ['NEW1', 'NEW2'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 2,
    })

    const baseline = log.renderMainScreenRepaintFromHome(next, prev, {
      clearRowsBeforeWrite: true,
    })
    expect(serializeDiff(baseline).includes(eraseToEndOfScreen())).toBe(false)

    const forced = log.renderMainScreenRepaintFromHome(next, prev, {
      clearRowsBeforeWrite: true,
      forceClearViewportRemainder: true,
    })
    const written = serializeDiff(forced)
    expect(written.includes(eraseToEndOfScreen())).toBe(true)
    expect(written.includes(ERASE_SCREEN)).toBe(false)
    expect(written).toContain('NEW1')
  })

  it('can recover alt-screen content from home without a terminal-wide erase', () => {
    const log = new LogUpdate({ isTTY: true, stylePool })
    const next = makeFrame({
      lines: ['RECOVER1', 'RECOVER2'],
      viewportWidth: 10,
      viewportHeight: 10,
      cursorY: 2,
    })

    const diff = log.renderFullRepaintFromHome(next, undefined, {
      clearRowsBeforeWrite: true,
    })
    const written = serializeDiff(diff)

    expect(written.startsWith('\u001b[H\u001b[K')).toBe(true)
    expect(written.includes('RECOVER1')).toBe(true)
    expect(written.includes('RECOVER2')).toBe(true)
    expect(written.includes(eraseToEndOfScreen())).toBe(true)
    expect(written.includes('\u001b[2J')).toBe(false)
    expect(written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('keeps written plain spaces inside a home repaint instead of fragmenting the row with cursor moves', () => {
    resetLogUpdateRenderStatsForTesting()
    const log = new LogUpdate({ isTTY: true, stylePool })
    const next = makeFrame({
      lines: ['  foo  bar'],
      viewportWidth: 20,
      viewportHeight: 10,
      cursorY: 1,
    })

    const diff = log.renderFullRepaintFromHome(next, undefined, {
      clearRowsBeforeWrite: true,
    })
    const written = serializeDiff(diff)
    const stats = getLogUpdateRenderStatsSnapshot()

    expect(written).toContain('  foo  bar')
    expect(stats.renderFrameSliceCalls).toBe(1)
    expect(stats.totalBufferedStdoutRuns).toBe(1)
    expect(stats.totalSameLineMoveCursorCalls).toBe(0)
    expect(stats.totalBufferedGapFillCalls).toBeGreaterThan(0)
    expect(stats.totalBufferedGapFillCells).toBeGreaterThan(0)
  })

  it('repaints ordinary in-viewport shrink from the previous output origin', () => {
    const prev = makeFrame({
      lines: ['aa', 'bb'],
      viewportWidth: 10,
      viewportHeight: 10,
      cursorY: 2,
    })
    const next = makeFrame({
      lines: ['aa'],
      viewportWidth: 10,
      viewportHeight: 10,
      cursorY: 1,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.startsWith('\r')).toBe(true)
    expect(result.written).toContain('aa')
    expect(result.written).not.toContain('bb')
    expect(result.written.includes('\u001b[H')).toBe(false)
    expect(result.written.includes('\u001b[2J')).toBe(false)
  })

  it('uses a home-based repaint when overflowing content shrinks back to fit the viewport', () => {
    const prev = makeFrame({
      lines: ['0', '1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })
    const next = makeFrame({
      lines: ['1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 5,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.startsWith('\u001b[H')).toBe(true)
    expect(result.written.includes('1')).toBe(true)
    expect(result.written.includes('5')).toBe(true)
    expect(result.written.includes('\u001b[2J')).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('does not reset for steady-state hidden-row changes while scrollback exists', () => {
    const prev = makeFrame({
      lines: ['0', '1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })
    const next = makeFrame({
      lines: ['x', '1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written).toBe('')
    expect(result.written.includes(ERASE_SCREEN)).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('does not reset for hidden-row changes during growth when the row stays unreachable', () => {
    const prev = makeFrame({
      lines: ['0', '1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })
    const next = makeFrame({
      lines: ['x', '1', '2', '3', '4', '5', '6'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 7,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.includes('6')).toBe(true)
    expect(result.written.includes(ERASE_SCREEN)).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('does not reset for hidden-row changes during shrink when the row stays unreachable', () => {
    const prev = makeFrame({
      lines: ['0', '1', '2', '3', '4', '5', '6', '7'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 8,
    })
    const next = makeFrame({
      lines: ['x', '1', '2', '3', '4', '5', '6'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 7,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.includes(ERASE_SCREEN)).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('still resets when growth makes a previously hidden changed row visible', () => {
    const prev = makeFrame({
      lines: ['0', '1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })
    const next = makeFrame({
      lines: ['x', '1', '2', '3', '4', '5', '6'],
      viewportWidth: 10,
      viewportHeight: 10,
      cursorY: 7,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.startsWith('\u001b[H')).toBe(true)
    expect(result.written.includes('x')).toBe(true)
    expect(result.written.includes('\u001b[2J')).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('still resets when shrink makes a previously hidden changed row visible', () => {
    const prev = makeFrame({
      lines: ['0', '1', '2', '3', '4', '5', '6', '7'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 8,
    })
    const next = makeFrame({
      lines: ['0', '1', '2', 'x', '4', '5', '6'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 7,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.startsWith('\u001b[H')).toBe(true)
    expect(result.written.includes('x')).toBe(true)
    expect(result.written.includes('\u001b[2J')).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('repaints once a previously ignored hidden-row diff becomes visible again', () => {
    const log = new LogUpdate({ isTTY: true, stylePool })
    const prev = makeFrame({
      lines: ['0', '1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })
    const hiddenDiff = makeFrame({
      lines: ['x', '1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })
    const visibleAgain = makeFrame({
      lines: ['x', '1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 7,
      cursorY: 6,
    })

    const hiddenResult = runTransitionWithLog(log, prev, hiddenDiff)
    expect(hiddenResult.clearPatch).toBeUndefined()
    expect(hiddenResult.written).toBe('')

    const visibleResult = runTransitionWithLog(log, hiddenDiff, visibleAgain)
    expect(visibleResult.clearPatch).toBeUndefined()
    expect(visibleResult.written.startsWith('\u001b[H')).toBe(true)
    expect(visibleResult.written.includes('\u001b[2J')).toBe(false)
    expect(visibleResult.written.includes('x')).toBe(true)
    expect(visibleResult.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('still resets for large shrinks that remove more than a viewport of content', () => {
    const prev = makeFrame({
      lines: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 12,
    })
    const next = makeFrame({
      lines: ['6', '7', '8', '9', 'a', 'b'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.startsWith('\u001b[H')).toBe(true)
    expect(result.written.includes('6')).toBe(true)
    expect(result.written.includes('b')).toBe(true)
    expect(result.written.includes('\u001b[2J')).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('skips tail-clearing when a repaint row fully overwrites the viewport width', () => {
    const prev = makeFrame({
      lines: ['012345678901'],
      viewportWidth: 12,
      viewportHeight: 1,
      cursorY: 1,
    })
    const next = makeFrame({
      lines: ['0123456789'],
      viewportWidth: 10,
      viewportHeight: 1,
      cursorY: 1,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.startsWith('\u001b[H')).toBe(true)
    expect(result.written.includes('\u001b[K')).toBe(false)
    expect(result.written.includes('0123456789')).toBe(true)
  })

  it('does not reset when only still-visible rows change while scrollback exists', () => {
    const prev = makeFrame({
      lines: ['0', '1', '2', '3', '4', '5'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })
    const next = makeFrame({
      lines: ['0', '1', '2', '3', '4', 'x'],
      viewportWidth: 10,
      viewportHeight: 5,
      cursorY: 6,
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written.includes('x')).toBe(true)
    expect(result.written.includes(ERASE_SCREEN)).toBe(false)
    expect(result.written.includes(ERASE_SCROLLBACK)).toBe(false)
  })

  it('stays incremental when width-shrink diffs are only clipped non-visible tail cells', () => {
    const fgOnlyStyle = 2
    const prev = makeFrame({
      lines: ['A'],
      viewportWidth: 10,
      viewportHeight: 10,
      cells: [
        { x: 0, y: 0, char: 'A', styleId: fgOnlyStyle },
        { x: 9, y: 0, char: ' ', styleId: fgOnlyStyle },
      ],
    })
    const next = makeFrame({
      lines: ['A'],
      viewportWidth: 8,
      viewportHeight: 10,
      cells: [{ x: 0, y: 0, char: 'A', styleId: fgOnlyStyle }],
    })

    const result = runTransition(prev, next)

    expect(result.clearPatch).toBeUndefined()
    expect(result.written).toBe('')
    expect(result.written.includes('\u001b[H')).toBe(false)
    expect(result.written.includes('\u001b[2J')).toBe(false)
  })

  it('wraps reset repaints in synchronized-output markers on supported terminals', () => {
    const written = withSupportedSyncEnv(() =>
      serializeDiff(
        [
          { type: 'clearTerminal', reason: 'offscreen' },
          { type: 'stdout', content: 'ABC' },
        ],
        false,
      ),
    )

    expect(written).toBe(
      withSupportedSyncEnv(
        () => `${BSU}${getResetSequenceForReason('offscreen')}ABC${ESU}`,
      ),
    )
  })
})
