import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getAgentsMemoryFiles,
  clearAgentsMemoryFilesCache,
} from './agentsmd.js'
import { setOriginalCwd } from '../bootstrap/state.js'
import { getCanonicalNcodeConfigHomeDir } from './envUtils.js'

const BUN_BIN = Bun.which('bun') ?? process.execPath
const CODE_ROOT = join(import.meta.dir, '../..')

async function withFakeHome(
  fn: (homeDir: string) => Promise<void>,
): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'agentsmd-home-'))
  const originalHome = process.env.HOME
  const originalNcodeConfigDir = process.env.NCODE_CONFIG_DIR
  process.env.HOME = homeDir
  process.env.NCODE_CONFIG_DIR = join(homeDir, '.ncode')
  try {
    await fn(homeDir)
  } finally {
    clearAgentsMemoryFilesCache()
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    if (originalNcodeConfigDir === undefined) {
      delete process.env.NCODE_CONFIG_DIR
    } else {
      process.env.NCODE_CONFIG_DIR = originalNcodeConfigDir
    }
    await rm(homeDir, { recursive: true, force: true })
  }
}

async function withProjectDir(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), 'agentsmd-project-'))
  const originalCwd = process.cwd()
  await mkdir(join(projectDir, '.git'), { recursive: true })
  process.chdir(projectDir)
  setOriginalCwd(projectDir)
  clearAgentsMemoryFilesCache()
  try {
    await fn(projectDir)
  } finally {
    clearAgentsMemoryFilesCache()
    process.chdir(originalCwd)
    setOriginalCwd(originalCwd)
    await rm(projectDir, { recursive: true, force: true })
  }
}

describe('agentsmd project memory discovery', () => {
  it('discovers AGENTS.md in the project root', async () => {
    await withProjectDir(async projectDir => {
      await writeFile(
        join(projectDir, 'AGENTS.md'),
        '# Agent instructions\nUse TypeScript.',
        'utf8',
      )

      const files = await getAgentsMemoryFiles()
      const paths = files.map(file => file.path)

      expect(paths).toContain(join(projectDir, 'AGENTS.md'))
      expect(files.find(file => file.path === join(projectDir, 'AGENTS.md'))?.content).toContain(
        'Use TypeScript.',
      )
    })
  })

  it('discovers .agents/AGENTS.md and .agents/CLAUDE.md', async () => {
    await withProjectDir(async projectDir => {
      await mkdir(join(projectDir, '.agents'), { recursive: true })
      await writeFile(
        join(projectDir, '.agents', 'AGENTS.md'),
        '# Nested agents\nRun tests first.',
        'utf8',
      )
      await writeFile(
        join(projectDir, '.agents', 'CLAUDE.md'),
        '# Legacy nested\nUse biome.',
        'utf8',
      )

      const paths = (await getAgentsMemoryFiles()).map(file => file.path)

      expect(paths).toContain(join(projectDir, '.agents', 'AGENTS.md'))
      expect(paths).toContain(join(projectDir, '.agents', 'CLAUDE.md'))
    })
  })

  it('discovers .agents/rules/*.md conditional and unconditional rules', async () => {
    await withProjectDir(async projectDir => {
      const rulesDir = join(projectDir, '.agents', 'rules')
      await mkdir(rulesDir, { recursive: true })
      await writeFile(
        join(rulesDir, 'typescript.md'),
        'Prefer strict TypeScript.',
        'utf8',
      )

      const files = await getAgentsMemoryFiles()
      const paths = files.map(file => file.path)

      expect(paths).toContain(join(rulesDir, 'typescript.md'))
    })
  })

  it('stops at the project memory boundary', async () => {
    const script = [
      'process.env.NCODE_BUILD_MODE = "noumena";',
      `const { setOriginalCwd } = await import(${JSON.stringify('./src/bootstrap/state.js')});`,
      `const { getAgentsMemoryFiles } = await import(${JSON.stringify('./src/utils/agentsmd.js')});`,
      `setOriginalCwd(${JSON.stringify(CODE_ROOT)});`,
      'const files = await getAgentsMemoryFiles();',
      'const projectFiles = files.filter(file => file.type === "Project").map(file => file.path);',
      'console.log(JSON.stringify(projectFiles));',
    ].join('\n')

    const result = Bun.spawnSync({
      cmd: [BUN_BIN, '-e', script],
      cwd: CODE_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })

    expect(result.exitCode).toBe(0)
    const projectFiles = JSON.parse(result.stdout.toString()) as string[]
    expect(projectFiles).not.toContain(join(dirname(CODE_ROOT), 'AGENTS.md'))
  })

  it('discovers user-level .agents instructions', async () => {
    await withFakeHome(async homeDir => {
      const agentsDir = join(homeDir, '.ncode', '.agents')
      await mkdir(agentsDir, { recursive: true })
      await writeFile(
        join(agentsDir, 'AGENTS.md'),
        '# User agents\nAlways write tests.',
        'utf8',
      )

      const files = await getAgentsMemoryFiles()
      const paths = files.map(file => file.path)

      expect(paths).toContain(join(agentsDir, 'AGENTS.md'))
    })
  })
})
