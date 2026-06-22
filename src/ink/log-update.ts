import {
  type AnsiCode,
  ansiCodesToString,
  diffAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { logForDebugging } from '../utils/debug.js'
import type { Diff, Frame } from './frame.js'
import type { Point } from './layout/geometry.js'
import {
  recordGapFillAnalysis,
  recordBufferedGapFill,
  recordBufferedNextRowPrefixFill,
  recordIncrementalDiffStats,
  recordIncrementalGapFillCandidate,
  recordNextRowContentEndFallback,
  recordNextRowPrefixAnalysis,
  recordNextRowPrefixPartialRemainingDistance,
  recordIncrementalTailClearShortcut,
  recordMoveCursorStats,
  recordRenderFrameSliceStats,
  recordWriteCellStats,
} from './logUpdateRenderStats.js'
import {
  analyzeFillableSpaceGap,
  type Cell,
  CellWidth,
  diffEach,
  createScreen,
  hasVisibleCellAt,
  type Hyperlink,
  isEmptyCellAt,
  skippedContentSpaceStyleIdAt,
  type StylePool,
  shiftRows,
  visibleCellAtIndex,
  visibleCellAtIndexInto,
} from './screen.js'
import {
  CURSOR_HOME,
  ERASE_SCREEN,
  eraseToEndOfLine,
  eraseToEndOfScreen,
  scrollDown as csiScrollDown,
  scrollUp as csiScrollUp,
  RESET_SCROLL_REGION,
  setScrollRegion,
} from './termio/csi.js'
import { LINK_END, link as oscLink } from './termio/osc.js'

type State = {
  previousOutput: string
  highestIgnoredHiddenRow: number | undefined
}

type Options = {
  isTTY: boolean
  stylePool: StylePool
}

export type RenderOutput = {
  diff: Diff
  physicalFrame: Frame
}

const CARRIAGE_RETURN = { type: 'carriageReturn' } as const
const NEWLINE = { type: 'stdout', content: '\n' } as const

export class LogUpdate {
  private state: State

  constructor(private readonly options: Options) {
    this.state = {
      previousOutput: '',
      highestIgnoredHiddenRow: undefined,
    }
  }

  renderPreviousOutput_DEPRECATED(prevFrame: Frame): Diff {
    if (!this.options.isTTY) {
      // Non-TTY output is no longer supported (string output was removed)
      return [NEWLINE]
    }
    return this.getRenderOpsForDone(prevFrame)
  }

  // Called when process resumes from suspension (SIGCONT) to prevent clobbering terminal content
  reset(): void {
    this.state.previousOutput = ''
    this.state.highestIgnoredHiddenRow = undefined
  }

  renderFullRepaintFromHome(
    frame: Frame,
    previousFrame?: Frame,
    options?: {
      clearRowsBeforeWrite?: boolean
      clearViewportBeforeWrite?: boolean
    },
  ): RenderOutput {
    this.state.previousOutput = ''
    this.state.highestIgnoredHiddenRow = undefined

    if (!this.options.isTTY) {
      return {
        diff: this.renderFullFrame(frame),
        physicalFrame: frame,
      }
    }

    return {
      diff: fullViewportRepaintFromHome(
        frame,
        this.options.stylePool,
        previousFrame,
        options,
      ),
      physicalFrame: frame,
    }
  }

  renderFullRepaintFromPreviousOutputTop(
    prev: Frame,
    frame: Frame,
    options?: {
      clearRowsBeforeWrite?: boolean
    },
  ): RenderOutput {
    this.state.previousOutput = ''
    this.state.highestIgnoredHiddenRow = undefined

    if (!this.options.isTTY) {
      return {
        diff: this.renderFullFrame(frame),
        physicalFrame: frame,
      }
    }

    return {
      diff: fullRepaintFromPreviousOutputTop(
        prev,
        frame,
        this.options.stylePool,
        options,
      ),
      physicalFrame: frame,
    }
  }

  renderMainScreenRepaintFromHome(
    frame: Frame,
    previousFrame?: Frame,
    options?: {
      clearRowsBeforeWrite?: boolean
      clearViewportBeforeWrite?: boolean
      forceClearViewportRemainder?: boolean
    },
  ): RenderOutput {
    this.state.previousOutput = ''
    this.state.highestIgnoredHiddenRow = undefined

    if (!this.options.isTTY) {
      return {
        diff: this.renderFullFrame(frame),
        physicalFrame: frame,
      }
    }

    return mainScreenViewportRepaintFromHome(
      frame,
      this.options.stylePool,
      previousFrame,
      options,
    )
  }

  private renderFullFrame(frame: Frame): Diff {
    const { screen } = frame
    const lines: string[] = []
    let currentStyles: AnsiCode[] = []
    let currentHyperlink: Hyperlink = undefined
    for (let y = 0; y < screen.height; y++) {
      let line = ''
      for (let x = 0; x < screen.width; x++) {
        const cell = cellAt(screen, x, y)
        if (cell && cell.width !== CellWidth.SpacerTail) {
          // Handle hyperlink transitions
          if (cell.hyperlink !== currentHyperlink) {
            if (currentHyperlink !== undefined) {
              line += LINK_END
            }
            if (cell.hyperlink !== undefined) {
              line += oscLink(cell.hyperlink)
            }
            currentHyperlink = cell.hyperlink
          }
          const cellStyles = this.options.stylePool.get(cell.styleId)
          const styleDiff = diffAnsiCodes(currentStyles, cellStyles)
          if (styleDiff.length > 0) {
            line += ansiCodesToString(styleDiff)
            currentStyles = cellStyles
          }
          line += cell.char
        }
      }
      // Close any open hyperlink before resetting styles
      if (currentHyperlink !== undefined) {
        line += LINK_END
        currentHyperlink = undefined
      }
      // Reset styles at end of line so trimEnd doesn't leave dangling codes
      const resetCodes = diffAnsiCodes(currentStyles, [])
      if (resetCodes.length > 0) {
        line += ansiCodesToString(resetCodes)
        currentStyles = []
      }
      lines.push(line.trimEnd())
    }

    if (lines.length === 0) {
      return []
    }
    return [{ type: 'stdout', content: lines.join('\n') }]
  }

  private getRenderOpsForDone(prev: Frame): Diff {
    this.state.previousOutput = ''

    if (!prev.cursor.visible) {
      return [{ type: 'cursorShow' }]
    }
    return []
  }

  render(
    prev: Frame,
    next: Frame,
    altScreen = false,
    decstbmSafe = true,
  ): RenderOutput {
    const startTime = performance.now()
    const stylePool = this.options.stylePool
    const physicalNext = altScreen
      ? next
      : clipMainScreenFrameToVisibleRows(next, stylePool)

    if (!this.options.isTTY) {
      return {
        diff: this.renderFullFrame(next),
        physicalFrame: physicalNext,
      }
    }

    const widthResizeStaysIncremental =
	    prev.viewport.width !== next.viewport.width &&
	    canStayIncrementalAcrossWidthResize(prev, next)

    // Since we assume the cursor is at the bottom on the screen, we only need
    // to clear when the viewport gets shorter (i.e. the cursor position drifts)
    // or when it gets thinner (and text wraps). We _could_ figure out how to
    // not reset here but that would involve predicting the current layout
    // _after_ the viewport change which means calcuating text wrapping.
    // Resizing is a rare enough event that it's not practically a big issue.
    if (shouldResetForResize(prev, next)) {
      this.state.highestIgnoredHiddenRow = undefined
      if (!altScreen && canRepaintFromPreviousOutputTop(prev)) {
        return {
          diff: fullRepaintFromPreviousOutputTop(prev, next, stylePool, {
            clearRowsBeforeWrite: true,
          }),
          physicalFrame: physicalNext,
        }
      }
      return {
        diff: fullViewportRepaintFromHome(next, stylePool, prev),
        physicalFrame: physicalNext,
      }
    }

    // DECSTBM scroll optimization: when a ScrollBox's scrollTop changed,
    // shift content with a hardware scroll (CSI top;bot r + CSI n S/T)
    // instead of rewriting the whole scroll region. The shiftRows on
    // prev.screen simulates the shift so the diff loop below naturally
    // finds only the rows that scrolled IN as diffs. prev.screen is
    // about to become backFrame (reused next render) so mutation is safe.
    // CURSOR_HOME after RESET_SCROLL_REGION is defensive — DECSTBM reset
    // homes cursor per spec but terminal implementations vary.
    //
    // decstbmSafe: caller passes false when the DECSTBM→diff sequence
    // can't be made atomic (no DEC 2026 / BSU/ESU). Without atomicity the
    // outer terminal renders the intermediate state — region scrolled,
    // edge rows not yet painted — a visible vertical jump on every frame
    // where scrollTop moves. Falling through to the diff loop writes all
    // shifted rows: more bytes, no intermediate state. next.screen from
    // render-node-to-output's blit+shift is correct either way.
	    let scrollPatch: Diff = []
	    if (altScreen && next.scrollHint && decstbmSafe) {
	      const { top, bottom, delta } = next.scrollHint
	      if (
	        top >= 0 &&
	        bottom < prev.screen.height &&
	        bottom < next.screen.height
	      ) {
	        prev = cloneFrameForMutation(prev, stylePool)
	        shiftRows(prev.screen, top, bottom, delta)
	        scrollPatch = [
          {
            type: 'stdout',
            content:
              setScrollRegion(top + 1, bottom + 1) +
              (delta > 0 ? csiScrollUp(delta) : csiScrollDown(-delta)) +
              RESET_SCROLL_REGION +
              CURSOR_HOME,
          },
        ]
      }
    }

    // We have to use purely relative operations to manipulate the cursor since
    // we don't know its starting point.
    //
    // When content height >= viewport height AND cursor is at the bottom,
    // the cursor restore at the end of the previous frame caused terminal scroll.
    // viewportY tells us how many rows are in scrollback from content overflow.
    // Additionally, the cursor-restore scroll pushes 1 more row into scrollback.
    // The precise unreachable-row fence lives later in the diff loop where we
    // can apply the same spacer / empty-cell skips as normal incremental paint.
    const cursorAtBottom = prev.cursor.y >= prev.screen.height
    const isGrowing = next.screen.height > prev.screen.height
    // When content fills the viewport exactly (height == viewport) and the
    // cursor is at the bottom, the cursor-restore LF at the end of the
    // previous frame scrolled 1 row into scrollback. Use >= to catch this.
    const prevHadScrollback =
      cursorAtBottom && prev.screen.height >= prev.viewport.height
    const isShrinking = next.screen.height < prev.screen.height
    const nextFitsViewport = next.screen.height <= prev.viewport.height

    // Shrinking clears physical rows as part of removing the tail of the old
    // frame. After that clear, the old screen buffer is no longer a safe
    // source of truth for "unchanged" rows: rows that diffEach would skip may
    // already have been erased or may be offset by one row after a prior
    // cursor-restore. Repaint the surviving visible frame from the previous
    // output origin when it is reachable. This keeps permission/preview
    // teardown deterministic without paying a full terminal reset.
    if (!altScreen && isShrinking && canRepaintFromPreviousOutputTop(prev)) {
      this.state.highestIgnoredHiddenRow = undefined
      return {
        diff: fullRepaintFromPreviousOutputTop(prev, next, stylePool, {
          clearRowsBeforeWrite: true,
        }),
        physicalFrame: physicalNext,
      }
    }

    // When shrinking from above-viewport to at-or-below-viewport, content that
    // was in scrollback should now be visible. Terminal clear operations can't
    // bring scrollback content into view, so we need a full reset.
    // Use <= (not <) because even when next height equals viewport height, the
    // scrollback depth from the previous render differs from a fresh render.
    if (prevHadScrollback && nextFitsViewport && isShrinking) {
      logForDebugging(
        `Full reset (shrink->below): prevHeight=${prev.screen.height}, nextHeight=${next.screen.height}, viewport=${prev.viewport.height}`,
      )
      this.state.highestIgnoredHiddenRow = undefined
      return {
        diff: fullViewportRepaintFromHome(next, stylePool, prev),
        physicalFrame: physicalNext,
      }
    }

    const screen = new VirtualScreen(prev.cursor, next.viewport.width)

    // Treat empty screen as height 1 to avoid spurious adjustments on first render
    const heightDelta =
      Math.max(next.screen.height, 1) - Math.max(prev.screen.height, 1)
    const shrinking = heightDelta < 0
    const growing = heightDelta > 0

    // Handle shrinking: clear lines from the bottom
    if (shrinking) {
      const linesToClear = prev.screen.height - next.screen.height

      // clear(N) moves cursor UP by N-1 lines and to column 0
      // This puts us at line prev.screen.height - N = next.screen.height
      // But we want to be at next.screen.height - 1 (bottom of new screen)
      screen.txn(prev => [
        [
          { type: 'clear', count: linesToClear },
          { type: 'cursorMove', x: 0, y: -1 },
        ],
        { dx: -prev.x, dy: -linesToClear },
      ])
    }

    // viewportY = number of rows in scrollback (not visible on terminal).
    // For shrinking: use max(prev, next) because terminal clears don't scroll.
    // For growing: use prev state because new rows haven't scrolled old ones yet.
    // When prevHadScrollback, add 1 for the cursor-restore LF that scrolled
    // an additional row out of view at the end of the previous frame. Without
    // this, the diff loop treats that row as reachable — but the cursor clamps
    // at viewport top, causing writes to land 1 row off and garbling the output.
    const cursorRestoreScroll = prevHadScrollback ? 1 : 0
    const viewportY = growing
      ? Math.max(
          0,
          prev.screen.height - prev.viewport.height + cursorRestoreScroll,
        )
      : Math.max(prev.screen.height, next.screen.height) -
        next.viewport.height +
        cursorRestoreScroll
    const nextCursorRestoreScroll =
      next.cursor.y >= next.screen.height && next.screen.height >= next.viewport.height
        ? 1
        : 0
    const nextViewportY = Math.max(
      0,
      next.screen.height - next.viewport.height + nextCursorRestoreScroll,
    )
    if (
      this.state.highestIgnoredHiddenRow !== undefined &&
      this.state.highestIgnoredHiddenRow >= nextViewportY
    ) {
      this.state.highestIgnoredHiddenRow = undefined
      return {
        diff: fullViewportRepaintFromHome(next, stylePool, prev),
        physicalFrame: physicalNext,
      }
    }
    let currentStyleId = stylePool.none
    let currentHyperlink: Hyperlink = undefined
    let highestIgnoredHiddenRow = this.state.highestIgnoredHiddenRow

    // First pass: render changes to existing rows (rows < prev.screen.height)
    let needsFullReset = false
    const incrementalDiffStart = performance.now()
    let incrementalDiffCallbackDurationMs = 0
    const clearedRowTailFrom = new Int32Array(next.screen.height)
    clearedRowTailFrom.fill(-1)
    diffEach(prev.screen, next.screen, (x, y, removed, added) => {
      const incrementalDiffCallbackStart = performance.now()
      try {
        if (
          y >= 0 &&
          y < clearedRowTailFrom.length &&
          clearedRowTailFrom[y] !== -1 &&
          x >= clearedRowTailFrom[y]!
        ) {
          return
        }

        // Skip new rows - we'll render them directly after
        if (growing && y >= prev.screen.height) {
          return
        }

        // Skip spacers during rendering because the terminal will automatically
        // advance 2 columns when we write the wide character itself.
        // SpacerTail: Second cell of a wide character
        // SpacerHead: Marks line-end position where wide char wraps to next line
        if (
          added &&
          (added.width === CellWidth.SpacerTail ||
            added.width === CellWidth.SpacerHead)
        ) {
          return
        }

        if (
          removed &&
          (removed.width === CellWidth.SpacerTail ||
            removed.width === CellWidth.SpacerHead) &&
          !added
        ) {
          return
        }

        // Skip empty cells that don't need to overwrite existing content.
        // This prevents writing trailing spaces that would cause unnecessary
        // line wrapping at the edge of the screen.
        // Uses isEmptyCellAt to check if both packed words are zero (empty cell).
        if (added && isEmptyCellAt(next.screen, x, y) && !removed) {
          return
        }

        // If the cell outside the viewport range has changed, we need to reset
        // because we can't move the cursor there to draw.
        //
        // If the changed row stays above the final viewport after this frame
        // completes, it remains unreachable for the whole transition. Keep that
        // scrollback stale until it becomes visible again instead of blanking the
        // visible screen just to keep offscreen history perfect.
        if (y < viewportY) {
          if (y < nextViewportY) {
            highestIgnoredHiddenRow = Math.max(highestIgnoredHiddenRow ?? -1, y)
            return
          }
          needsFullReset = true
          return true // early exit
        }

        if (x >= next.viewport.width) {
          if (
            widthResizeStaysIncremental &&
            !rowHasVisibleContentInRange(prev, y, x, x + 1)
          ) {
            return
          }

          needsFullReset = true
          return true // early exit
        }

        const nextRowContentEnd = next.screen.contentEnd[y] ?? 0

        if (screen.cursor.x !== x || screen.cursor.y !== y) {
          const gapAnalysis =
            screen.cursor.y === y && x > screen.cursor.x
              ? analyzeFillableSpaceGap(
                  next.screen,
                  y,
                  screen.cursor.x,
                  x,
                  currentStyleId,
                  currentHyperlink,
                  stylePool.none,
                )
              : null

          if (gapAnalysis) {
            recordGapFillAnalysis(gapAnalysis)
          }

          const gapFillCells =
            gapAnalysis?.blocker === 'none' ? gapAnalysis.fillableCells : 0

          recordIncrementalGapFillCandidate(gapFillCells)

          if (gapFillCells === x - screen.cursor.x && gapFillCells > 0) {
            screen.txn(() => [
              [{ type: 'stdout', content: ' '.repeat(gapFillCells) }],
              { dx: gapFillCells, dy: 0 },
            ])
            recordBufferedGapFill(gapFillCells)
          } else if (screen.cursor.y + 1 === y && x > 0) {
            if (
              removed &&
              (!added || isEmptyCellAt(next.screen, x, y)) &&
              nextRowContentEnd === 0
            ) {
              const styleIdToReset = currentStyleId
              const hyperlinkToReset = currentHyperlink
              currentStyleId = stylePool.none
              currentHyperlink = undefined

              screen.txn(prev => {
                const patches: Diff = [CARRIAGE_RETURN, NEWLINE]
                transitionStyle(patches, stylePool, styleIdToReset, stylePool.none)
                transitionHyperlink(patches, hyperlinkToReset, undefined)
                patches.push({ type: 'stdout', content: eraseToEndOfLine() })
                return [patches, { dx: -prev.x, dy: 1 }]
              })
              clearedRowTailFrom[y] = 0
              recordIncrementalTailClearShortcut()
              return
            }

            const nextRowPrefixAnalysis = analyzeFillableSpaceGap(
              next.screen,
              y,
              0,
              x,
              currentStyleId,
              currentHyperlink,
              stylePool.none,
            )
            recordNextRowPrefixAnalysis(nextRowPrefixAnalysis)
            if (
              nextRowPrefixAnalysis.blocker !== 'none' &&
              nextRowPrefixAnalysis.fillableCells > 0
            ) {
              recordNextRowPrefixPartialRemainingDistance(
                x - nextRowPrefixAnalysis.fillableCells,
              )
            }
            if (
              nextRowPrefixAnalysis.blocker === 'none' &&
              nextRowPrefixAnalysis.fillableCells === x
            ) {
              screen.txn(prev => [
                [CARRIAGE_RETURN, NEWLINE, { type: 'stdout', content: ' '.repeat(x) }],
                { dx: x - prev.x, dy: 1 },
              ])
              recordBufferedNextRowPrefixFill(x)
            } else if (nextRowPrefixAnalysis.blocker === 'content-end') {
              // The row has no content beyond the known end. Move to the next
              // row with CR+LF first, then apply only horizontal movement.
              // This avoids paying an extra down-move escape on the dominant
              // content-end blocker path while preserving cursor semantics.
              const nextCellEmpty = isEmptyCellAt(next.screen, x, y)
              recordNextRowContentEndFallback({
                nextRowContentEnd,
                pendingWrap: screen.cursor.x >= screen.viewportWidth,
                hasRemoved: !!removed,
                hasAdded: !!added,
                nextCellEmpty,
                nextCellKind:
                  !nextCellEmpty && added
                    ? added.width === CellWidth.SpacerTail ||
                      added.width === CellWidth.SpacerHead
                      ? 'spacer'
                      : added.char === ' '
                        ? 'styled-space'
                      : 'visible-char'
                    : undefined,
              })
              recordMoveCursorStats('line-change-next-row-offset')
              screen.txn(prev => [
                [CARRIAGE_RETURN, NEWLINE, { type: 'cursorMove', x, y: 0 }],
                { dx: x - prev.x, dy: 1 },
              ])
            } else if (nextRowPrefixAnalysis.fillableCells > 0) {
              const fillablePrefix = nextRowPrefixAnalysis.fillableCells
              const remainingX = x - fillablePrefix
              const patches: Diff = [
                CARRIAGE_RETURN,
                NEWLINE,
                { type: 'stdout', content: ' '.repeat(fillablePrefix) },
              ]
              if (remainingX > 0) {
                patches.push({ type: 'cursorMove', x: remainingX, y: 0 })
                recordMoveCursorStats('line-change-next-row-offset')
              }
              screen.txn(prev => [patches, { dx: x - prev.x, dy: 1 }])
              recordBufferedNextRowPrefixFill(fillablePrefix)
            } else {
              moveCursorTo(screen, x, y)
            }
          } else {
            moveCursorTo(screen, x, y)
          }
        }

        if (
          removed &&
          (!added || isEmptyCellAt(next.screen, x, y)) &&
          x >= nextRowContentEnd
        ) {
          const styleIdToReset = currentStyleId
          const hyperlinkToReset = currentHyperlink
          currentStyleId = stylePool.none
          currentHyperlink = undefined

          screen.txn(() => {
            const patches: Diff = []
            transitionStyle(patches, stylePool, styleIdToReset, stylePool.none)
            transitionHyperlink(patches, hyperlinkToReset, undefined)
            patches.push({ type: 'stdout', content: eraseToEndOfLine() })
            return [patches, { dx: 0, dy: 0 }]
          })
          clearedRowTailFrom[y] = x
          recordIncrementalTailClearShortcut()
          return
        }

        if (added) {
          const targetHyperlink = added.hyperlink
          currentHyperlink = transitionHyperlink(
            screen.diff,
            currentHyperlink,
            targetHyperlink,
          )
          const styleStr = stylePool.transition(currentStyleId, added.styleId)
          if (writeCellWithStyleStr(screen, added, styleStr)) {
            currentStyleId = added.styleId
          }
        } else if (removed) {
          // Cell was removed - clear it with a space
          // (This handles shrinking content)
          // Reset any active styles/hyperlinks first to avoid leaking into cleared cells
          const styleIdToReset = currentStyleId
          const hyperlinkToReset = currentHyperlink
          currentStyleId = stylePool.none
          currentHyperlink = undefined

          screen.txn(() => {
            const patches: Diff = []
            transitionStyle(patches, stylePool, styleIdToReset, stylePool.none)
            transitionHyperlink(patches, hyperlinkToReset, undefined)
            patches.push({ type: 'stdout', content: ' ' })
            return [patches, { dx: 1, dy: 0 }]
          })
        }
      } finally {
        incrementalDiffCallbackDurationMs +=
          performance.now() - incrementalDiffCallbackStart
      }
    })
    recordIncrementalDiffStats({
      incrementalDiffDurationMs: performance.now() - incrementalDiffStart,
      incrementalDiffCallbackDurationMs,
    })
    if (needsFullReset) {
      this.state.highestIgnoredHiddenRow = undefined
      return {
        diff: fullViewportRepaintFromHome(next, stylePool, prev),
        physicalFrame: physicalNext,
      }
    }
    this.state.highestIgnoredHiddenRow = highestIgnoredHiddenRow

    // Reset styles before rendering new rows (they'll set their own styles)
    currentStyleId = transitionStyle(
      screen.diff,
      stylePool,
      currentStyleId,
      stylePool.none,
    )
    currentHyperlink = transitionHyperlink(
      screen.diff,
      currentHyperlink,
      undefined,
    )

    // Handle growth: render new rows directly (they naturally scroll the terminal)
    if (growing) {
      renderFrameSlice(
        screen,
        next,
        prev.screen.height,
        next.screen.height,
        stylePool,
      )
    }

    // Restore cursor. Skipped in alt-screen: the cursor is hidden, its
    // position only matters as the starting point for the NEXT frame's
    // relative moves, and in alt-screen the next frame always begins with
    // CSI H (see ink.tsx onRender) which resets to (0,0) regardless. This
    // saves a CR + cursorMove round-trip (~6-10 bytes) every frame.
    //
    // Main screen: if cursor needs to be past the last line of content
    // (typical: cursor.y = screen.height), emit \n to create that line
    // since cursor movement can't create new lines.
    if (altScreen) {
      // no-op; next frame's CSI H anchors cursor
    } else if (next.cursor.y >= next.screen.height) {
      // Move to column 0 of current line, then emit newlines to reach target row
      screen.txn(prev => {
        const rowsToCreate = next.cursor.y - prev.y
        if (rowsToCreate > 0) {
          // Use CR to resolve pending wrap (if any) without advancing
          // to the next line, then LF to create each new row.
          const patches: Diff = new Array<Diff[number]>(1 + rowsToCreate)
          patches[0] = CARRIAGE_RETURN
          for (let i = 0; i < rowsToCreate; i++) {
            patches[1 + i] = NEWLINE
          }
          return [patches, { dx: -prev.x, dy: rowsToCreate }]
        }
        // At or past target row - need to move cursor to correct position
        const dy = next.cursor.y - prev.y
        if (dy !== 0 || prev.x !== next.cursor.x) {
          // Use CR to clear pending wrap (if any), then cursor move
          const patches: Diff = [CARRIAGE_RETURN]
          patches.push({ type: 'cursorMove', x: next.cursor.x, y: dy })
          return [patches, { dx: next.cursor.x - prev.x, dy }]
        }
        return [[], { dx: 0, dy: 0 }]
      })
    } else {
      moveCursorTo(screen, next.cursor.x, next.cursor.y)
    }

    const elapsed = performance.now() - startTime
    if (elapsed > 50) {
      const damage = next.screen.damage
      const damageInfo = damage
        ? `${damage.width}x${damage.height} at (${damage.x},${damage.y})`
        : 'none'
      logForDebugging(
        `Slow render: ${elapsed.toFixed(1)}ms, screen: ${next.screen.height}x${next.screen.width}, damage: ${damageInfo}, changes: ${screen.diff.length}`,
      )
    }

    return {
      diff: scrollPatch.length > 0
        ? [...scrollPatch, ...screen.diff]
        : screen.diff,
      physicalFrame: physicalNext,
    }
  }
}

export function shouldResetForResize(prev: Frame, next: Frame): boolean {
  if (prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width) {
    if (canStayIncrementalAcrossWidthResize(prev, next)) {
      return false
    }
    return true
  }

  if (next.viewport.height >= prev.viewport.height) {
    return false
  }

  if (
    prev.cursor.y >= next.viewport.height ||
    next.cursor.y >= next.viewport.height
  ) {
    return true
  }

  if (prev.screen.height <= next.viewport.height) {
    return false
  }

  return !canStayIncrementalAcrossHeightShrink(prev, next)
}

export function canRepaintFromPreviousOutputTop(frame: Frame): boolean {
  return (
    frame.viewport.height > 0 &&
    frame.screen.height < frame.viewport.height &&
    frame.cursor.y < frame.viewport.height
  )
}

function canStayIncrementalAcrossHeightShrink(
  prev: Frame,
  next: Frame,
): boolean {
  if (next.screen.height > next.viewport.height) {
    return false
  }

  if (hasScrollbackRisk(prev) || hasScrollbackRisk(next)) {
    return false
  }

  const prevVisibleHeight = Math.min(prev.screen.height, prev.viewport.height)
  const visibleWidth = Math.min(prev.screen.width, prev.viewport.width)

  for (let row = next.viewport.height; row < prevVisibleHeight; row += 1) {
    if (rowHasVisibleContentInRange(prev, row, 0, visibleWidth)) {
      return false
    }
  }

  return true
}

function canStayIncrementalAcrossWidthResize(
  prev: Frame,
  next: Frame,
): boolean {
  if (next.viewport.height !== prev.viewport.height) {
    return false
  }

  if (prev.screen.height !== next.screen.height) {
    return false
  }

  if (
    prev.cursor.x >= next.viewport.width ||
    next.cursor.x >= next.viewport.width ||
    prev.cursor.y >= next.viewport.height ||
    next.cursor.y >= next.viewport.height
  ) {
    return false
  }

  if (hasScrollbackRisk(prev) || hasScrollbackRisk(next)) {
    return false
  }

  const visibleRows = Math.min(prev.screen.height, prev.viewport.height)
  for (let row = 0; row < visibleRows; row += 1) {
    if (next.viewport.width < prev.viewport.width) {
      if (!rowFitsWithinWidth(prev, row, next.viewport.width)) {
        return false
      }
      continue
    }

    if (!rowLeavesRightMargin(prev, row, prev.viewport.width)) {
      return false
    }
  }

  return true
}

function hasScrollbackRisk(frame: Frame): boolean {
  return frame.cursor.y >= frame.screen.height && frame.screen.height >= frame.viewport.height
}

function rowFitsWithinWidth(
  frame: Frame,
  row: number,
  widthLimit: number,
): boolean {
  if (row < 0 || row >= frame.screen.height) {
    return true
  }

  const { width, cells, charPool, hyperlinkPool } = frame.screen
  const scanWidth = Math.min(width, frame.viewport.width)
  const rowStart = row * width
  let lastRenderedStyleId = -1
  const scratchCell: Cell = {
    char: ' ',
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  }

  for (let x = 0; x < scanWidth; x += 1) {
    if (
      !visibleCellAtIndexInto(
        cells,
        charPool,
        hyperlinkPool,
        rowStart + x,
        lastRenderedStyleId,
        scratchCell,
      )
    ) {
      continue
    }
    const cell = scratchCell
    const cellWidth = cell.width === CellWidth.Wide ? 2 : 1
    if (x + cellWidth > widthLimit) {
      return false
    }
    lastRenderedStyleId = cell.styleId
  }

  return true
}

function rowLeavesRightMargin(
  frame: Frame,
  row: number,
  widthLimit: number,
): boolean {
  if (row < 0 || row >= frame.screen.height) {
    return true
  }

  const { width, cells, charPool, hyperlinkPool } = frame.screen
  const scanWidth = Math.min(width, frame.viewport.width)
  const rowStart = row * width
  let lastRenderedStyleId = -1
  const scratchCell: Cell = {
    char: ' ',
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  }

  for (let x = 0; x < scanWidth; x += 1) {
    if (
      !visibleCellAtIndexInto(
        cells,
        charPool,
        hyperlinkPool,
        rowStart + x,
        lastRenderedStyleId,
        scratchCell,
      )
    ) {
      continue
    }
    const cell = scratchCell
    const cellWidth = cell.width === CellWidth.Wide ? 2 : 1
    if (x + cellWidth >= widthLimit) {
      return false
    }
    lastRenderedStyleId = cell.styleId
  }

  return true
}

function transitionHyperlink(
  diff: Diff,
  current: Hyperlink,
  target: Hyperlink,
): Hyperlink {
  if (current !== target) {
    diff.push({ type: 'hyperlink', uri: target ?? '' })
    return target
  }
  return current
}

function transitionStyle(
  diff: Diff,
  stylePool: StylePool,
  currentId: number,
  targetId: number,
): number {
  const str = stylePool.transition(currentId, targetId)
  if (str.length > 0) {
    diff.push({ type: 'styleStr', str })
  }
  return targetId
}

function fullViewportRepaintFromHome(
  frame: Frame,
  stylePool: StylePool,
  previousFrame?: Frame,
  options?: {
    clearRowsBeforeWrite?: boolean
    clearViewportBeforeWrite?: boolean
    forceClearViewportRemainder?: boolean
  },
): Diff {
  const screen = new VirtualScreen({ x: 0, y: 0 }, frame.viewport.width)
  screen.diff.push({
    type: 'stdout',
    content: options?.clearViewportBeforeWrite
      ? ERASE_SCREEN + CURSOR_HOME
      : CURSOR_HOME,
  })
  // shouldClearViewportRemainder returns false on identical-dimension frames
  // (empty-row loop), leaving stale cells below content on ctrl+l spam.
  // Force ESC[J (clear-to-end) without an ESC[2J that would scroll content
  // into scrollback.
  const clearToViewportEnd =
    options?.forceClearViewportRemainder ||
    shouldClearViewportRemainder(previousFrame, frame)
  renderFrameSlice(screen, frame, 0, frame.screen.height, stylePool, {
    clearRowTails: !options?.clearRowsBeforeWrite,
    clearRowsBeforeWrite: options?.clearRowsBeforeWrite,
    clearToViewportEnd,
    previousFrame,
  })
  return screen.diff
}

function fullRepaintFromPreviousOutputTop(
  prev: Frame,
  frame: Frame,
  stylePool: StylePool,
  options?: {
    clearRowsBeforeWrite?: boolean
  },
): Diff {
  const screen = new VirtualScreen({ x: 0, y: 0 }, frame.viewport.width)
  const rowsToOrigin = Math.max(0, prev.cursor.y)
  screen.diff.push(CARRIAGE_RETURN)
  if (rowsToOrigin > 0) {
    screen.diff.push({ type: 'cursorMove', x: 0, y: -rowsToOrigin })
  }
  renderFrameSlice(screen, frame, 0, frame.screen.height, stylePool, {
    clearRowTails: !options?.clearRowsBeforeWrite,
    clearRowsBeforeWrite: options?.clearRowsBeforeWrite,
    clearToViewportEnd: shouldClearViewportRemainder(prev, frame),
    previousFrame: prev,
  })
  return screen.diff
}

function mainScreenViewportRepaintFromHome(
  frame: Frame,
  stylePool: StylePool,
  previousFrame?: Frame,
  options?: {
    clearRowsBeforeWrite?: boolean
    clearViewportBeforeWrite?: boolean
    forceClearViewportRemainder?: boolean
  },
): RenderOutput {
  const visibleFrame = clipMainScreenFrameToVisibleRows(frame, stylePool)
  const visiblePreviousFrame = previousFrame
    ? clipMainScreenFrameToVisibleRows(previousFrame, stylePool)
    : undefined
  const repaintPreviousFrame = options?.clearViewportBeforeWrite
    ? undefined
    : visiblePreviousFrame

  return {
    diff: fullViewportRepaintFromHome(
      visibleFrame,
      stylePool,
      repaintPreviousFrame,
      options,
    ),
    physicalFrame: visibleFrame,
  }
}

function cloneFrameForMutation(frame: Frame, stylePool: StylePool): Frame {
  const source = frame.screen
  const screen = createScreen(
    source.width,
    source.height,
    stylePool,
    source.charPool,
    source.hyperlinkPool,
  )
  screen.cells.set(source.cells)
  screen.noSelect.set(source.noSelect)
  screen.softWrap.set(source.softWrap)
  screen.contentEnd.set(source.contentEnd)
  if (source.damage) {
    screen.damage = { ...source.damage }
  }

  return {
    ...frame,
    screen,
  }
}

function clipMainScreenFrameToVisibleRows(
  frame: Frame,
  stylePool: StylePool,
): Frame {
  // Main-screen repaint from CSI H starts at the visible viewport home, not at
  // the logical output origin in scrollback. renderFrameSlice emits CRLF after
  // every row, so painting a full viewport would scroll the bottom row and
  // duplicate/garble the visible screen. Keep the logical frame intact for the
  // next incremental diff, but repaint only the visible content suffix here.
  const visibleRows = Math.max(0, frame.viewport.height - 1)
  if (frame.screen.height <= visibleRows) {
    return frame
  }

  const sourceStartY = Math.max(0, frame.screen.height - visibleRows)
  const clippedHeight = frame.screen.height - sourceStartY
  const source = frame.screen
  const screen = createScreen(
    source.width,
    clippedHeight,
    stylePool,
    source.charPool,
    source.hyperlinkPool,
  )

  const cellWordsPerRow = source.width << 1
  const sourceCellStart = sourceStartY * cellWordsPerRow
  screen.cells.set(
    source.cells.subarray(
      sourceCellStart,
      sourceCellStart + clippedHeight * cellWordsPerRow,
    ),
  )

  const sourceNoSelectStart = sourceStartY * source.width
  screen.noSelect.set(
    source.noSelect.subarray(
      sourceNoSelectStart,
      sourceNoSelectStart + clippedHeight * source.width,
    ),
  )
  screen.softWrap.set(
    source.softWrap.subarray(sourceStartY, sourceStartY + clippedHeight),
  )
  screen.contentEnd.set(
    source.contentEnd.subarray(sourceStartY, sourceStartY + clippedHeight),
  )

  return {
    screen,
    viewport: frame.viewport,
    cursor: {
      ...frame.cursor,
      y: Math.max(0, frame.cursor.y - sourceStartY),
    },
  }
}

type RenderFrameSliceOptions = {
  clearRowTails?: boolean
  clearRowsBeforeWrite?: boolean
  clearToViewportEnd?: boolean
  previousFrame?: Frame
}

/**
 * Render a slice of rows from the frame's screen.
 * Each row is rendered followed by a newline. Cursor ends at (0, endY).
 */
function renderFrameSlice(
  screen: VirtualScreen,
  frame: Frame,
  startY: number,
  endY: number,
  stylePool: StylePool,
  options?: RenderFrameSliceOptions,
): VirtualScreen {
  const renderFrameSliceStart = performance.now()
  let currentStyleId = stylePool.none
  let currentHyperlink: Hyperlink = undefined
  // Track the styleId of the last rendered cell on this line (-1 if none).
  // Passed to visibleCellAtIndex to enable fg-only space optimization.
  let lastRenderedStyleId = -1
  let lastCoveredColumn = 0

  const { width: screenWidth, cells, charPool, hyperlinkPool } = frame.screen
  let visibleCells = 0
  let skippedCells = 0
  let rowAdvanceBranchHits = 0
  let writeCellCalls = 0
  let writeCellSuccesses = 0
  let writeCellFailures = 0
  let visibleCellLookupDurationMs = 0
  let moveCursorDurationMs = 0
  let hyperlinkTransitionDurationMs = 0
  let styleTransitionDurationMs = 0
  let writeCellDurationMs = 0
  let bufferedStdoutRuns = 0
  let bufferedStdoutCells = 0
  let bufferedStdoutBytes = 0
  let bufferedGapFillCalls = 0
  let bufferedGapFillCells = 0
  const scratchCell: Cell = {
    char: ' ',
    styleId: stylePool.none,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  }
  let bufferedStdout = ''
  let bufferedStdoutColumns = 0

  const flushBufferedStdout = () => {
    if (bufferedStdoutColumns === 0) {
      return
    }
    screen.diff.push({ type: 'stdout', content: bufferedStdout })
    bufferedStdoutRuns += 1
    bufferedStdoutCells += bufferedStdoutColumns
    bufferedStdoutBytes += Buffer.byteLength(bufferedStdout)
    bufferedStdout = ''
    bufferedStdoutColumns = 0
  }

  let index = startY * screenWidth
  for (let y = startY; y < endY; y += 1) {
    const rowContentEnd = frame.screen.contentEnd[y] ?? 0
    // Advance cursor to this row using LF (not CSI CUD / cursor-down).
    // CSI CUD stops at the viewport bottom margin and cannot scroll,
    // but LF scrolls the viewport to create new lines. Without this,
    // when the cursor is at the viewport bottom, moveCursorTo's
    // cursor-down silently fails, creating a permanent off-by-one
    // between the virtual cursor and the real terminal cursor.
    if (screen.cursor.y < y) {
      rowAdvanceBranchHits += 1
      const rowsToAdvance = y - screen.cursor.y
      screen.txn(prev => {
        const patches: Diff = new Array<Diff[number]>(1 + rowsToAdvance)
        patches[0] = CARRIAGE_RETURN
        for (let i = 0; i < rowsToAdvance; i++) {
          patches[1 + i] = NEWLINE
        }
        return [patches, { dx: -prev.x, dy: rowsToAdvance }]
      })
    }
    if (options?.clearRowsBeforeWrite) {
      screen.diff.push({ type: 'stdout', content: eraseToEndOfLine() })
    }
    // Reset at start of each line — no cell rendered yet
    lastRenderedStyleId = -1
    lastCoveredColumn = 0

    for (let x = 0; x < screenWidth; x += 1, index += 1) {
      // Skip spacers, unstyled empty cells, and fg-only styled spaces that
      // match the last rendered style (since cursor-forward produces identical
      // visual result). visibleCellAtIndex handles the optimization internally
      // to avoid allocating Cell objects for skipped cells.
      const visibleCellLookupStart = performance.now()
      const cellVisible = visibleCellAtIndexInto(
        cells,
        charPool,
        hyperlinkPool,
        index,
        lastRenderedStyleId,
        scratchCell,
      )
      visibleCellLookupDurationMs += performance.now() - visibleCellLookupStart
      if (!cellVisible) {
        const ci = index << 1
        const skippedSpaceStyleId =
          rowContentEnd > x
            ? skippedContentSpaceStyleIdAt(cells, index, lastRenderedStyleId)
            : undefined
        if (
          skippedSpaceStyleId !== undefined &&
          shouldOverwriteSkippedRepaintSpace(options?.previousFrame, y, x)
        ) {
          flushBufferedStdout()
          if (screen.cursor.x !== x || screen.cursor.y !== y) {
            const moveCursorStart = performance.now()
            moveCursorTo(screen, x, y)
            moveCursorDurationMs += performance.now() - moveCursorStart
          }
          currentHyperlink = transitionHyperlink(
            screen.diff,
            currentHyperlink,
            undefined,
          )
          currentStyleId = transitionStyle(
            screen.diff,
            stylePool,
            currentStyleId,
            skippedSpaceStyleId,
          )
          screen.diff.push({ type: 'stdout', content: ' ' })
          if (screen.cursor.x >= screen.viewportWidth) {
            screen.cursor.x = 1
            screen.cursor.y += 1
          } else {
            screen.cursor.x += 1
          }
          lastCoveredColumn = x + 1
          lastRenderedStyleId = skippedSpaceStyleId
          continue
        }
        const isPlainWrittenSpace =
          rowContentEnd > x &&
          currentStyleId === stylePool.none &&
          currentHyperlink === undefined &&
          cells[ci] === 0 &&
          cells[ci + 1] === 0
        if (isPlainWrittenSpace) {
          bufferedStdout += ' '
          bufferedStdoutColumns += 1
          bufferedGapFillCalls += 1
          bufferedGapFillCells += 1
          if (screen.cursor.x >= screen.viewportWidth) {
            screen.cursor.x = 1
            screen.cursor.y += 1
          } else {
            screen.cursor.x += 1
          }
          lastCoveredColumn = x + 1
          lastRenderedStyleId = stylePool.none
          continue
        }
        skippedCells += 1
        continue
      }
      const cell = scratchCell
      visibleCells += 1
      if (
        screen.cursor.y === y &&
        x > screen.cursor.x &&
        currentStyleId === stylePool.none &&
        currentHyperlink === undefined
      ) {
        const gap = x - screen.cursor.x
        bufferedStdout += ' '.repeat(gap)
        bufferedStdoutColumns += gap
        bufferedGapFillCalls += 1
        bufferedGapFillCells += gap
        screen.cursor.x = x
        lastCoveredColumn = x
      }
      if (screen.cursor.x !== x || screen.cursor.y !== y) {
        flushBufferedStdout()
        const moveCursorStart = performance.now()
        moveCursorTo(screen, x, y)
        moveCursorDurationMs += performance.now() - moveCursorStart
      }

      // Handle hyperlink
      const targetHyperlink = cell.hyperlink
      if (targetHyperlink !== currentHyperlink) {
        flushBufferedStdout()
        const hyperlinkTransitionStart = performance.now()
        currentHyperlink = transitionHyperlink(
          screen.diff,
          currentHyperlink,
          targetHyperlink,
        )
        hyperlinkTransitionDurationMs +=
          performance.now() - hyperlinkTransitionStart
      }

      const canUseBufferedStdout =
        cell.width === CellWidth.Narrow && !needsWidthCompensation(cell.char)

      if (canUseBufferedStdout) {
        if (cell.styleId !== currentStyleId) {
          flushBufferedStdout()
          const styleTransitionStart = performance.now()
          const styleStr = stylePool.transition(currentStyleId, cell.styleId)
          styleTransitionDurationMs += performance.now() - styleTransitionStart
          if (styleStr.length > 0) {
            screen.diff.push({ type: 'styleStr', str: styleStr })
          }
          currentStyleId = cell.styleId
        }
        bufferedStdout += cell.char
        bufferedStdoutColumns += 1
        if (screen.cursor.x >= screen.viewportWidth) {
          screen.cursor.x = 1
          screen.cursor.y += 1
        } else {
          screen.cursor.x += 1
        }
        lastCoveredColumn = x + 1
        lastRenderedStyleId = cell.styleId
        continue
      }

      // Style transition — cached string, zero allocations after warmup
      flushBufferedStdout()
      let styleStr = ''
      if (cell.styleId !== currentStyleId) {
        const styleTransitionStart = performance.now()
        styleStr = stylePool.transition(currentStyleId, cell.styleId)
        styleTransitionDurationMs += performance.now() - styleTransitionStart
      }
      writeCellCalls += 1
      const writeCellStart = performance.now()
      if (writeCellWithStyleStr(screen, cell, styleStr)) {
        writeCellSuccesses += 1
        lastCoveredColumn = x + (cell.width === CellWidth.Wide ? 2 : 1)
        currentStyleId = cell.styleId
        lastRenderedStyleId = cell.styleId
      } else {
        writeCellFailures += 1
      }
      writeCellDurationMs += performance.now() - writeCellStart
    }
    flushBufferedStdout()
    // Reset styles/hyperlinks before newline so background color doesn't
    // bleed into the next line when the terminal scrolls. The old code
    // reset implicitly by writing trailing unstyled spaces; now that we
    // skip empty cells, we must reset explicitly.
    currentStyleId = transitionStyle(
      screen.diff,
      stylePool,
      currentStyleId,
      stylePool.none,
    )
    currentHyperlink = transitionHyperlink(
      screen.diff,
      currentHyperlink,
      undefined,
    )
    if (
      options?.clearRowTails &&
      shouldClearRepaintRowTail(
        options.previousFrame,
        y,
        lastCoveredColumn,
        screenWidth,
      )
    ) {
      screen.diff.push({ type: 'stdout', content: eraseToEndOfLine() })
    }
    // CR+LF at end of row — \r resets to column 0, \n moves to next line.
    // Without \r, the terminal cursor stays at whatever column content ended
    // (since we skip trailing spaces, this can be mid-row).
    screen.txn(prev => [[CARRIAGE_RETURN, NEWLINE], { dx: -prev.x, dy: 1 }])
  }

  // Reset any open style/hyperlink at end of slice
  transitionStyle(screen.diff, stylePool, currentStyleId, stylePool.none)
  transitionHyperlink(screen.diff, currentHyperlink, undefined)
  if (options?.clearToViewportEnd) {
    screen.diff.push({ type: 'stdout', content: eraseToEndOfScreen() })
  }

  recordRenderFrameSliceStats({
    renderFrameSliceDurationMs: performance.now() - renderFrameSliceStart,
    visibleCellLookupDurationMs,
    moveCursorDurationMs,
    hyperlinkTransitionDurationMs,
    styleTransitionDurationMs,
    writeCellDurationMs,
    rows: endY - startY,
    visibleCells,
    skippedCells,
    rowAdvanceBranchHits,
    rowEndCrlfCount: endY - startY,
    writeCellCalls,
    writeCellSuccesses,
    writeCellFailures,
    bufferedStdoutRuns,
    bufferedStdoutCells,
    bufferedStdoutBytes,
    bufferedGapFillCalls,
    bufferedGapFillCells,
  })

  return screen
}

function shouldClearRepaintRowTail(
  previousFrame: Frame | undefined,
  row: number,
  fromX: number,
  viewportWidth: number,
): boolean {
  if (fromX >= viewportWidth) {
    return false
  }

  if (!previousFrame || row < 0 || row >= previousFrame.screen.height) {
    return true
  }

  const visibleWidth = Math.min(previousFrame.screen.width, viewportWidth)
  if (fromX >= visibleWidth) {
    return false
  }

  return rowHasVisibleContentInRange(previousFrame, row, fromX, visibleWidth)
}

function shouldClearViewportRemainder(
  previousFrame: Frame | undefined,
  nextFrame: Frame,
): boolean {
  if (nextFrame.screen.height >= nextFrame.viewport.height) {
    return false
  }

  if (!previousFrame) {
    return true
  }

  const prevVisibleHeight = Math.min(
    previousFrame.screen.height,
    previousFrame.viewport.height,
  )

  for (let row = nextFrame.screen.height; row < prevVisibleHeight; row += 1) {
    if (
      rowHasVisibleContentInRange(
        previousFrame,
        row,
        0,
        Math.min(previousFrame.screen.width, previousFrame.viewport.width),
      )
    ) {
      return true
    }
  }

  if (previousFrame.viewport.width > nextFrame.viewport.width) {
    const scanHeight = Math.min(nextFrame.screen.height, prevVisibleHeight)
    for (let row = 0; row < scanHeight; row += 1) {
      if (
        rowHasVisibleContentInRange(
          previousFrame,
          row,
          nextFrame.viewport.width,
          Math.min(previousFrame.screen.width, previousFrame.viewport.width),
        )
      ) {
        return true
      }
    }
  }

  return false
}

function rowHasVisibleContentInRange(
  frame: Frame,
  row: number,
  fromX: number,
  toX: number,
): boolean {
  if (row < 0 || row >= frame.screen.height || fromX >= toX) {
    return false
  }

  const { width, cells, charPool, hyperlinkPool } = frame.screen
  const rowStart = row * width
  let lastRenderedStyleId = -1
  const scratchCell: Cell = {
    char: ' ',
    styleId: 0,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  }

  for (let x = 0; x < toX; x += 1) {
    if (
      !visibleCellAtIndexInto(
        cells,
        charPool,
        hyperlinkPool,
        rowStart + x,
        lastRenderedStyleId,
        scratchCell,
      )
    ) {
      continue
    }
    const cell = scratchCell

    if (x >= fromX) {
      return true
    }
    lastRenderedStyleId = cell.styleId
  }

  return false
}

function shouldOverwriteSkippedRepaintSpace(
  previousFrame: Frame | undefined,
  row: number,
  x: number,
): boolean {
  return (
    previousFrame !== undefined &&
    hasVisibleCellAt(previousFrame.screen, x, row)
  )
}

type Delta = { dx: number; dy: number }

/**
 * Write a cell with a pre-serialized style transition string (from
 * StylePool.transition). Inlines the txn logic to avoid closure/tuple/delta
 * allocations on every cell.
 *
 * Returns true if the cell was written, false if skipped (wide char at
 * viewport edge). Callers MUST gate currentStyleId updates on this — when
 * skipped, styleStr is never pushed and the terminal's style state is
 * unchanged. Updating the virtual tracker anyway desyncs it from the
 * terminal, and the next transition is computed from phantom state.
 */
function writeCellWithStyleStr(
  screen: VirtualScreen,
  cell: Cell,
  styleStr: string,
): boolean {
  const cellWidth = cell.width === CellWidth.Wide ? 2 : 1
  const px = screen.cursor.x
  const vw = screen.viewportWidth
  const needsCompensation = cellWidth === 2 && needsWidthCompensation(cell.char)

  // Don't write wide chars that would cross the viewport edge.
  // Single-codepoint chars (CJK) at vw-2 are safe; multi-codepoint
  // graphemes (flags, ZWJ emoji) need stricter threshold.
  if (cellWidth === 2 && px < vw) {
    const threshold = cell.char.length > 2 ? vw : vw + 1
    if (px + 2 >= threshold) {
      recordWriteCellStats({
        styleStrNonEmpty: styleStr.length > 0,
        wideEdgeSkip: true,
        needsWidthCompensation: needsCompensation,
        wideCell: true,
      })
      return false
    }
  }

  recordWriteCellStats({
    styleStrNonEmpty: styleStr.length > 0,
    wideEdgeSkip: false,
    needsWidthCompensation: needsCompensation,
    wideCell: cellWidth === 2,
  })

  const diff = screen.diff
  if (styleStr.length > 0) {
    diff.push({ type: 'styleStr', str: styleStr })
  }

  // On terminals with old wcwidth tables, a compensated emoji only advances
  // the cursor 1 column, so the CHA below skips column x+1 without painting
  // it. Write a styled space there first — on correct terminals the emoji
  // glyph (width 2) overwrites it harmlessly; on old terminals it fills the
  // gap with the emoji's background. Also clears any stale content at x+1.
  // CHA is 1-based, so column px+1 (0-based) is CHA target px+2.
  if (needsCompensation && px + 1 < vw) {
    diff.push({ type: 'cursorTo', col: px + 2 })
    diff.push({ type: 'stdout', content: ' ' })
    diff.push({ type: 'cursorTo', col: px + 1 })
  }

  diff.push({ type: 'stdout', content: cell.char })

  // Force terminal cursor to correct column after the emoji.
  if (needsCompensation) {
    diff.push({ type: 'cursorTo', col: px + cellWidth + 1 })
  }

  // Update cursor — mutate in place to avoid Point allocation
  if (px >= vw) {
    screen.cursor.x = cellWidth
    screen.cursor.y++
  } else {
    screen.cursor.x = px + cellWidth
  }
  return true
}

function moveCursorTo(screen: VirtualScreen, targetX: number, targetY: number) {
  const dx = targetX - screen.cursor.x
  const dy = targetY - screen.cursor.y
  const inPendingWrap = screen.cursor.x >= screen.viewportWidth

  if (dx === 0 && dy === 0) {
    recordMoveCursorStats('noop')
    return
  }

  if (inPendingWrap) {
    recordMoveCursorStats('pending-wrap')
    screen.txn(() => [
      [CARRIAGE_RETURN, { type: 'cursorMove', x: targetX, y: dy }],
      { dx, dy },
    ])
    return
  }

  if (dy !== 0) {
    if (dy === 1) {
      recordMoveCursorStats(
        targetX === 0
          ? 'line-change-next-row-home'
          : 'line-change-next-row-offset',
      )
      if (targetX === 0) {
        screen.txn(prev => [[CARRIAGE_RETURN, NEWLINE], { dx: -prev.x, dy: 1 }])
        return
      }
      screen.txn(prev => [
        [CARRIAGE_RETURN, NEWLINE, { type: 'cursorMove', x: targetX, y: 0 }],
        { dx: targetX - prev.x, dy: 1 },
      ])
      return
    } else {
      recordMoveCursorStats(
        targetX === 0
          ? 'line-change-multi-row-home'
          : 'line-change-multi-row-offset',
      )
    }
    screen.txn(() => [
      [CARRIAGE_RETURN, { type: 'cursorMove', x: targetX, y: dy }],
      { dx, dy },
    ])
    return
  }

  recordMoveCursorStats('same-line')
  screen.txn(() => [[{ type: 'cursorMove', x: dx, y: dy }], { dx, dy }])
}

/**
 * Identify emoji where the terminal's wcwidth may disagree with Unicode.
 * On terminals with correct tables, the CHA we emit is a harmless no-op.
 *
 * Two categories:
 * 1. Newer emoji (Unicode 12.0+) missing from terminal wcwidth tables.
 * 2. Text-by-default emoji + VS16 (U+FE0F): the base codepoint is width 1
 *    in wcwidth, but VS16 triggers emoji presentation making it width 2.
 *    Examples: ⚔️ (U+2694), ☠️ (U+2620), ❤️ (U+2764).
 */
function needsWidthCompensation(char: string): boolean {
  const cp = char.codePointAt(0)
  if (cp === undefined) return false
  // U+1FA70-U+1FAFF: Symbols and Pictographs Extended-A (Unicode 12.0-15.0)
  // U+1FB00-U+1FBFF: Symbols for Legacy Computing (Unicode 13.0)
  if ((cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x1fb00 && cp <= 0x1fbff)) {
    return true
  }
  // Text-by-default emoji with VS16: scan for U+FE0F in multi-codepoint
  // graphemes. Single BMP chars (length 1) and surrogate pairs without VS16
  // skip this check. VS16 (0xFE0F) can't collide with surrogates (0xD800-0xDFFF).
  if (char.length >= 2) {
    for (let i = 0; i < char.length; i++) {
      if (char.charCodeAt(i) === 0xfe0f) return true
    }
  }
  return false
}


class VirtualScreen {
  // Public for direct mutation by writeCellWithStyleStr (avoids txn overhead).
  // File-private class — not exposed outside log-update.ts.
  cursor: Point
  diff: Diff = []

  constructor(
    origin: Point,
    readonly viewportWidth: number,
  ) {
    this.cursor = { ...origin }
  }

  txn(fn: (prev: Point) => [patches: Diff, next: Delta]): void {
    const [patches, next] = fn(this.cursor)
    for (const patch of patches) {
      this.diff.push(patch)
    }
    this.cursor.x += next.dx
    this.cursor.y += next.dy
  }
}
