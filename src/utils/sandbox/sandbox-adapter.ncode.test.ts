import { describe, expect, test } from 'bun:test'
import {
  getProtectedSettingsPathsForCwd,
  getProtectedSkillsPathsForCwd,
} from './sandbox-adapter.js'

describe('sandbox-adapter canonical ncode protections', () => {
  test('protects both canonical and legacy settings files for an arbitrary cwd', () => {
    expect(getProtectedSettingsPathsForCwd('/repo')).toEqual([
      '/repo/.ncode/settings.json',
      '/repo/.ncode/settings.local.json',
      '/repo/.claude/settings.json',
      '/repo/.claude/settings.local.json',
    ])
  })

  test('protects both canonical and legacy skills directories for an arbitrary cwd', () => {
    expect(getProtectedSkillsPathsForCwd('/repo')).toEqual([
      '/repo/.ncode/skills',
      '/repo/.claude/skills',
      '/repo/.agents/skills',
    ])
  })
})
