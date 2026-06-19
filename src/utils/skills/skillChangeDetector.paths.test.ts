import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { getAdditionalSkillWatchPaths } from './skillChangeDetector.js'

describe('skillChangeDetector managed path coverage', () => {
  test('includes canonical and legacy additional skill roots', () => {
    expect(getAdditionalSkillWatchPaths('/repo')).toEqual([
      join('/repo', '.ncode', 'skills'),
      join('/repo', '.claude', 'skills'),
      join('/repo', '.agents', 'skills'),
    ])
  })
})
