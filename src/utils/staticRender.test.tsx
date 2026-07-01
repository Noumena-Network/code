import { describe, expect, test } from 'bun:test'
import React from 'react'
import { Text } from '../ink.js'
import { renderToString } from './staticRender.js'

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

describe('static renderer', () => {
  test('resolves after the render tree exits', async () => {
    const output = await withTimeout(
      renderToString(<Text>static render complete</Text>, 80),
      1000,
    )

    expect(output).toContain('static render complete')
  })
})
