import { describe, expect, it } from 'bun:test'
import { _getMagicDocsAgentForTest } from '../../services/MagicDocs/magicDocs.js'
import { STATUSLINE_SETUP_AGENT } from './built-in/statuslineSetup.js'
import { EXPLORE_AGENT } from './built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { NCODE_GUIDE_AGENT } from './built-in/ncodeGuideAgent.js'
import { PLAN_AGENT } from './built-in/planAgent.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'

describe('managed built-in agent model declarations', () => {
  it('keeps interactive built-in helpers on the active session model by default', () => {
    expect(STATUSLINE_SETUP_AGENT.model).toBe('inherit')
    expect(_getMagicDocsAgentForTest().model).toBe('inherit')
  })

  it('documents the intentional built-in agent model policy', () => {
    for (const agent of [
      GENERAL_PURPOSE_AGENT,
      NCODE_GUIDE_AGENT,
      PLAN_AGENT,
      VERIFICATION_AGENT,
    ]) {
      expect([undefined, 'inherit']).toContain(agent.model)
    }

    // Explore is intentionally the cheap/fast read-only exception.
    expect([undefined, 'inherit', 'haiku']).toContain(EXPLORE_AGENT.model)
  })
})
