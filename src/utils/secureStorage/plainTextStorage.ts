import { chmodSync } from 'fs'
import { join } from 'path'
import { getCanonicalNcodeConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import type { SecureStorage, SecureStorageData } from './types.js'

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const path of paths) {
    if (seen.has(path)) {
      continue
    }
    seen.add(path)
    deduped.push(path)
  }
  return deduped
}

function getStoragePath(): { storageDir: string; storagePath: string } {
  const storageDir = getCanonicalNcodeConfigHomeDir()
  const storageFileName = '.credentials.json'
  return { storageDir, storagePath: join(storageDir, storageFileName) }
}

export function getPrimaryPlainTextStoragePath(): string {
  return getStoragePath().storagePath
}

export function getPlainTextStorageReadPaths(): string[] {
  return dedupePaths([getPrimaryPlainTextStoragePath()])
}

export function getExistingPlainTextStoragePath(): string | null {
  for (const storagePath of getPlainTextStorageReadPaths()) {
    if (getFsImplementation().existsSync(storagePath)) {
      return storagePath
    }
  }
  return null
}

export const plainTextStorage = {
  name: 'plaintext',
  read(): SecureStorageData | null {
    // sync IO: called from sync context (SecureStorage interface)
    for (const storagePath of getPlainTextStorageReadPaths()) {
      try {
        const data = getFsImplementation().readFileSync(storagePath, {
          encoding: 'utf8',
        })
        return jsonParse(data)
      } catch {
        continue
      }
    }
    return null
  },
  async readAsync(): Promise<SecureStorageData | null> {
    for (const storagePath of getPlainTextStorageReadPaths()) {
      try {
        const data = await getFsImplementation().readFile(storagePath, {
          encoding: 'utf8',
        })
        return jsonParse(data)
      } catch {
        continue
      }
    }
    return null
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // sync IO: called from sync context (SecureStorage interface)
    try {
      const { storageDir, storagePath } = getStoragePath()
      try {
        getFsImplementation().mkdirSync(storageDir)
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'EEXIST') {
          throw e
        }
      }

      writeFileSync_DEPRECATED(storagePath, jsonStringify(data), {
        encoding: 'utf8',
        flush: false,
      })
      chmodSync(storagePath, 0o600)
      return {
        success: true,
        warning: 'Warning: Storing credentials in plaintext.',
      }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      getFsImplementation().unlinkSync(storagePath)
      return true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return true
      }
      return false
    }
  },
} satisfies SecureStorage
