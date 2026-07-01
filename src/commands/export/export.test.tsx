import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { createUserMessage } from '../../utils/messages.js'
import { call } from './export.js'

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('/export command', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('writes filename exports without hanging', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ncode-export-'))
    tempDirs.push(cwd)
    const doneMessages: string[] = []
    const targetPath = join(cwd, 'conversation.txt')

    const node = await runWithCwdOverride(cwd, () =>
      withTimeout(
        call(
          message => {
            if (message) doneMessages.push(message)
          },
          {
            messages: [createUserMessage({ content: 'hello export' })],
            options: { tools: [] },
          } as never,
          'conversation.txt',
        ),
        1000,
      ),
    )

    expect(node).toBeNull()
    expect(doneMessages).toEqual([`Conversation exported to: ${targetPath}`])
    expect(existsSync(targetPath)).toBe(true)
    expect(readFileSync(targetPath, 'utf8')).toContain('hello export')
  })
})
