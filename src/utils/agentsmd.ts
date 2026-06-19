/**
 * AGENTS.md loading support.
 *
 * Files are loaded in the following order:
 *
 * 1. User memory (~/.ncode/.agents/AGENTS.md, ~/.ncode/.agents/CLAUDE.md, and
 *    ~/.ncode/.agents/rules/) - Private global instructions for all projects.
 * 2. Project memory (AGENTS.md, .agents/AGENTS.md, .agents/CLAUDE.md, and
 *    .agents/rules/ in project roots) - Instructions checked into the codebase.
 *
 * Files are loaded in reverse order of priority, i.e. the latest files are
 * highest priority with the model paying more attention to them. Files closer
 * to the current directory have higher priority (loaded later).
 *
 * Memory @include directive:
 * - Memory files can include other files using @ notation
 * - Syntax: @path, @./relative/path, @~/home/path, or @/absolute/path
 * - @path (without prefix) is treated as a relative path (same as @./path)
 * - Works in leaf text nodes only (not inside code blocks or code strings)
 * - Included files are added as separate entries before the including file
 * - Circular references are prevented by tracking processed files
 * - Non-existent files are silently ignored
 */

import memoize from 'lodash-es/memoize.js'
import { dirname, join, parse } from 'path'
import { getOriginalCwd } from '../bootstrap/state.js'
import {
  MemoryFileInfo,
  filterInjectedMemoryFiles,
  processConditionedMdRules,
  processMdRules,
  processMemoryFile,
} from './claudemd.js'
import { getCanonicalNcodeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { normalizePathForComparison } from './file.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import { isSettingSourceEnabled } from './settings/constants.js'

const PROJECT_MEMORY_BOUNDARY_MARKERS = ['.git', '.hg', '.sl', '.jj']

function dedupeInstructionPaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const normalized = path.normalize('NFC')
    if (seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function getUserAgentInstructionFilesLowToHigh(): string[] {
  return dedupeInstructionPaths([
    join(getCanonicalNcodeConfigHomeDir(), '.agents', 'CLAUDE.md'),
    join(getCanonicalNcodeConfigHomeDir(), '.agents', 'AGENTS.md'),
  ])
}

function getUserAgentInstructionRuleDirsLowToHigh(): string[] {
  return dedupeInstructionPaths([
    join(getCanonicalNcodeConfigHomeDir(), '.agents', 'rules'),
  ])
}

function getProjectAgentInstructionFilesLowToHigh(dir: string): string[] {
  return dedupeInstructionPaths([
    join(dir, '.agents', 'CLAUDE.md'),
    join(dir, '.agents', 'AGENTS.md'),
    join(dir, 'AGENTS.md'),
  ])
}

function getProjectAgentInstructionRuleDirsLowToHigh(dir: string): string[] {
  return dedupeInstructionPaths([join(dir, '.agents', 'rules')])
}

function findProjectMemoryBoundary(startPath: string): string | null {
  const fs = getFsImplementation()
  let currentDir = safeResolvePath(fs, startPath).resolvedPath

  while (true) {
    if (
      PROJECT_MEMORY_BOUNDARY_MARKERS.some(marker =>
        fs.existsSync(join(currentDir, marker)),
      )
    ) {
      return currentDir
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }
    currentDir = parentDir
  }
}

function pathInWorkingPath(child: string, parent: string): boolean {
  const relativePath = relativeSafe(parent, child)
  return relativePath !== '' && !relativePath.startsWith('..')
}

function relativeSafe(from: string, to: string): string {
  const fromParts = from.split(/[/\\]+/).filter(Boolean)
  const toParts = to.split(/[/\\]+/).filter(Boolean)
  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1
  }
  const up = fromParts.length - common
  const down = toParts.slice(common)
  return [...Array(up).fill('..'), ...down].join('/')
}

/**
 * Collects AGENTS.md / .agents/ memory files for the current project and user.
 *
 * This mirrors the discovery semantics of claudemd.ts for CLAUDE.md/NCODE.md
 * but scoped to agent instruction files. Processed memory files are typed as
 * 'Project' for checked-in or .agents/ files and 'User' for user-level files.
 */
export const getAgentsMemoryFiles = memoize(
  async (includeExternal: boolean = false): Promise<MemoryFileInfo[]> => {
    const result: MemoryFileInfo[] = []
    const processedPaths = new Set<string>()

    if (isSettingSourceEnabled('userSettings')) {
      for (const userInstructionFile of getUserAgentInstructionFilesLowToHigh()) {
        result.push(
          ...(await processMemoryFile(
            userInstructionFile,
            'User',
            processedPaths,
            true,
          )),
        )
      }
      for (const userInstructionRulesDir of getUserAgentInstructionRuleDirsLowToHigh()) {
        result.push(
          ...(await processMdRules({
            rulesDir: userInstructionRulesDir,
            type: 'User',
            processedPaths,
            includeExternal: true,
            conditionalRule: false,
          })),
        )
      }
    }

    if (!isSettingSourceEnabled('projectSettings')) {
      return result
    }

    const dirs: string[] = []
    const originalCwd = getOriginalCwd()
    const projectMemoryBoundary = findProjectMemoryBoundary(originalCwd)
    let currentDir = originalCwd

    while (currentDir !== parse(currentDir).root) {
      dirs.push(currentDir)
      if (
        projectMemoryBoundary !== null &&
        normalizePathForComparison(currentDir) ===
          normalizePathForComparison(projectMemoryBoundary)
      ) {
        break
      }
      currentDir = dirname(currentDir)
    }

    const gitRoot = findGitRoot(originalCwd)
    const canonicalRoot = findCanonicalGitRoot(originalCwd)
    const isNestedWorktree =
      gitRoot !== null &&
      canonicalRoot !== null &&
      normalizePathForComparison(gitRoot) !==
        normalizePathForComparison(canonicalRoot) &&
      pathInWorkingPath(gitRoot, canonicalRoot)

    for (const dir of dirs.reverse()) {
      const skipProject =
        isNestedWorktree &&
        pathInWorkingPath(dir, canonicalRoot!) &&
        !pathInWorkingPath(dir, gitRoot!)

      if (skipProject) {
        continue
      }

      for (const projectInstructionFile of getProjectAgentInstructionFilesLowToHigh(dir)) {
        result.push(
          ...(await processMemoryFile(
            projectInstructionFile,
            'Project',
            processedPaths,
            includeExternal,
          )),
        )
      }

      for (const rulesDir of getProjectAgentInstructionRuleDirsLowToHigh(dir)) {
        result.push(
          ...(await processMdRules({
            rulesDir,
            type: 'Project',
            processedPaths,
            includeExternal,
            conditionalRule: false,
          })),
        )
      }
    }

    return result
  },
  () => `${getOriginalCwd()}::${process.env.NCODE_CONFIG_DIR ?? ''}`,
)

/**
 * Clears the cached agent memory file discovery.
 */
export function clearAgentsMemoryFilesCache(): void {
  getAgentsMemoryFiles.cache?.clear?.()
}

/**
 * Formats discovered agent memory files into a system prompt section.
 *
 * This reuses the same formatting logic as CLAUDE.md/NCODE.md memory files.
 */
export async function getAgentsMds(
  filter?: (type: MemoryFileInfo['type']) => boolean,
): Promise<string> {
  const { getClaudeMds } = await import('./claudemd.js')
  return getClaudeMds(filterInjectedMemoryFiles(await getAgentsMemoryFiles()), filter)
}

// Allow opt-in caching disable in tests.
if (isEnvTruthy(process.env.NCODE_DISABLE_AGENTS_MD_CACHE)) {
  clearAgentsMemoryFilesCache()
}
