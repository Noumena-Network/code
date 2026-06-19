import { describe, expect, test } from 'bun:test'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getNcodeSkillScope, isNcodeSettingsPath } from './filesystem.js'

describe('managed config canonical .ncode paths', () => {
  test('treats .ncode settings files as managed settings paths', () => {
    expect(isNcodeSettingsPath('/repo/.ncode/settings.json')).toBe(true)
    expect(isNcodeSettingsPath('/repo/.ncode/settings.local.json')).toBe(true)
  })

  test('creates narrowed skill scope suggestions for .ncode skills', () => {
    expect(
      getNcodeSkillScope(
        `${getOriginalCwd()}/.ncode/skills/verify/SKILL.md`,
      ),
    ).toEqual({
      skillName: 'verify',
      pattern: '/.ncode/skills/verify/**',
    })
  })

  test('creates narrowed skill scope suggestions for .agents skills', () => {
    expect(
      getNcodeSkillScope(
        `${getOriginalCwd()}/.agents/skills/verify/SKILL.md`,
      ),
    ).toEqual({
      skillName: 'verify',
      pattern: '/.agents/skills/verify/**',
    })
  })
})
