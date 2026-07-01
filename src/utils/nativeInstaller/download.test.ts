import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { zipSync } from 'fflate'
import {
  downloadVersionFromGithubRelease,
  getLatestVersion,
  getLatestVersionFromGithubReleases,
} from './download.js'
import { getBinaryName, getPlatform } from './installer.js'

const originalAxiosGet = axios.get
const originalMacro = (globalThis as { MACRO?: unknown }).MACRO
const originalNativePackageUrl = process.env.NCODE_NATIVE_PACKAGE_URL

function setMacro(nativePackageUrl?: string): void {
  ;(globalThis as { MACRO?: { NATIVE_PACKAGE_URL?: string } }).MACRO = {
    NATIVE_PACKAGE_URL: nativePackageUrl,
  }
}

beforeEach(() => {
  axios.get = originalAxiosGet
  setMacro(undefined)
  delete process.env.NCODE_NATIVE_PACKAGE_URL
})

afterEach(() => {
  axios.get = originalAxiosGet
  ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
  if (originalNativePackageUrl === undefined) {
    delete process.env.NCODE_NATIVE_PACKAGE_URL
  } else {
    process.env.NCODE_NATIVE_PACKAGE_URL = originalNativePackageUrl
  }
})

describe('native installer public update sources', () => {
  it('uses GitHub releases as the default latest/stable version source', async () => {
    const getCalls: Array<unknown[]> = []
    axios.get = (async (...args: unknown[]) => {
      getCalls.push(args)
      return {
        data: [
          { draft: true, prerelease: false, tag_name: 'v9.9.9' },
          { draft: false, prerelease: true, tag_name: 'v1.3.0-beta.1' },
          { draft: false, prerelease: false, tag_name: 'v1.2.3' },
        ],
      }
    }) as typeof axios.get

    await expect(getLatestVersionFromGithubReleases('latest')).resolves.toBe(
      '1.3.0-beta.1',
    )
    await expect(getLatestVersionFromGithubReleases('stable')).resolves.toBe(
      '1.2.3',
    )

    expect(getCalls).toHaveLength(2)
    expect(getCalls[0]?.[0]).toBe(
      'https://api.github.com/repos/Noumena-Network/code/releases',
    )
    expect(getCalls[0]?.[1]).toMatchObject({
      responseType: 'json',
      params: { per_page: 25 },
    })
  })

  it('uses NCODE_NATIVE_PACKAGE_URL as an explicit binary-repo override', async () => {
    process.env.NCODE_NATIVE_PACKAGE_URL = 'https://storage.example.test/ncode'
    const getCalls: Array<unknown[]> = []
    axios.get = (async (...args: unknown[]) => {
      getCalls.push(args)
      return { data: '1.2.4\n' }
    }) as typeof axios.get

    await expect(getLatestVersion('latest')).resolves.toBe('1.2.4')

    expect(getCalls).toHaveLength(1)
    expect(getCalls[0]?.[0]).toBe('https://storage.example.test/ncode/latest')
  })

  it('downloads, verifies, and extracts a GitHub release zip asset', async () => {
    const version = '1.2.3'
    const platform = getPlatform()
    const binaryName = getBinaryName(platform)
    const artifactBaseName = `ncode-${version}-${platform}`
    const zipAssetName = `${artifactBaseName}.zip`
    const binaryBytes = new TextEncoder().encode('binary-ok')
    const zipBytes = Buffer.from(
      zipSync({ [`${artifactBaseName}/${binaryName}`]: binaryBytes }),
    )
    const checksum = createHash('sha256').update(zipBytes).digest('hex')
    const getCalls: Array<string> = []
    axios.get = (async (url: string) => {
      getCalls.push(url)
      if (url.endsWith('/tags/v1.2.3')) {
        return {
          data: {
            tag_name: 'v1.2.3',
            assets: [
              {
                name: zipAssetName,
                browser_download_url: 'https://github.example.test/asset.zip',
              },
              {
                name: `${zipAssetName}.sha256`,
                browser_download_url: 'https://github.example.test/asset.zip.sha256',
              },
            ],
          },
        }
      }
      if (url === 'https://github.example.test/asset.zip.sha256') {
        return { data: `${checksum}  ${zipAssetName}\n` }
      }
      if (url === 'https://github.example.test/asset.zip') {
        return { data: zipBytes }
      }
      throw new Error(`unexpected url ${url}`)
    }) as typeof axios.get

    const stagingPath = await mkdtemp(join(tmpdir(), 'ncode-gh-release-'))
    await rm(stagingPath, { recursive: true, force: true })
    try {
      await downloadVersionFromGithubRelease(version, stagingPath)
      await expect(readFile(join(stagingPath, binaryName), 'utf8')).resolves.toBe(
        'binary-ok',
      )
    } finally {
      await rm(stagingPath, { recursive: true, force: true })
    }

    expect(getCalls).toEqual([
      'https://api.github.com/repos/Noumena-Network/code/releases/tags/v1.2.3',
      'https://github.example.test/asset.zip.sha256',
      'https://github.example.test/asset.zip',
    ])
  })

  it('rejects GitHub release zip checksum mismatches', async () => {
    const version = '1.2.3'
    const platform = getPlatform()
    const zipAssetName = `ncode-${version}-${platform}.zip`
    const zipBytes = Buffer.from(zipSync({ 'ncode': new TextEncoder().encode('bad') }))
    axios.get = (async (url: string) => {
      if (url.endsWith('/tags/v1.2.3')) {
        return {
          data: {
            tag_name: 'v1.2.3',
            assets: [
              { name: zipAssetName, browser_download_url: 'https://github.example.test/asset.zip' },
              { name: `${zipAssetName}.sha256`, browser_download_url: 'https://github.example.test/asset.zip.sha256' },
            ],
          },
        }
      }
      if (url.endsWith('.sha256')) return { data: `deadbeef  ${zipAssetName}\n` }
      if (url.endsWith('.zip')) return { data: zipBytes }
      throw new Error(`unexpected url ${url}`)
    }) as typeof axios.get

    const stagingPath = await mkdtemp(join(tmpdir(), 'ncode-gh-release-bad-'))
    await rm(stagingPath, { recursive: true, force: true })
    try {
      await expect(
        downloadVersionFromGithubRelease(version, stagingPath),
      ).rejects.toThrow('Checksum mismatch')
    } finally {
      await rm(stagingPath, { recursive: true, force: true })
    }
  })
})
