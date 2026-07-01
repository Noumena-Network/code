import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getLatestVersionFromGcs } from './autoUpdater.js'

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

describe('package-manager updater public source', () => {
  it('uses GitHub releases when no binary repo override is configured', async () => {
    const calls: Array<unknown[]> = []
    axios.get = (async (...args: unknown[]) => {
      calls.push(args)
      return {
        data: [
          { draft: false, prerelease: true, tag_name: 'v2.0.0-beta.1' },
          { draft: false, prerelease: false, tag_name: 'v1.9.0' },
        ],
      }
    }) as typeof axios.get

    await expect(getLatestVersionFromGcs('latest')).resolves.toBe('2.0.0-beta.1')
    await expect(getLatestVersionFromGcs('stable')).resolves.toBe('1.9.0')

    expect(calls[0]?.[0]).toBe(
      'https://api.github.com/repos/Noumena-Network/code/releases',
    )
  })

  it('uses NCODE_NATIVE_PACKAGE_URL as the explicit binary-repo override', async () => {
    process.env.NCODE_NATIVE_PACKAGE_URL = 'https://storage.example.test/ncode'
    const calls: Array<unknown[]> = []
    axios.get = (async (...args: unknown[]) => {
      calls.push(args)
      return { data: '1.8.0\n' }
    }) as typeof axios.get

    await expect(getLatestVersionFromGcs('latest')).resolves.toBe('1.8.0')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('https://storage.example.test/ncode/latest')
  })
})
