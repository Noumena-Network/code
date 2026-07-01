/**
 * Download functionality for native installer
 *
 * Handles downloading NCode binaries from various sources:
 * - public or internal binary repositories
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import { createHash } from 'crypto'
import { unzipSync } from 'fflate'
import { chmod, writeFile } from 'fs/promises'
import { join } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import type { ReleaseChannel } from '../config.js'
import { logForDebugging } from '../debug.js'
import { toError } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { sleep } from '../sleep.js'
import { getBinaryName, getPlatform } from './installer.js'

// Builds may bake this value into MACRO.NATIVE_PACKAGE_URL. Deployments can
// override it with NCODE_NATIVE_PACKAGE_URL, including internal-only buckets.
function getPublicBinaryUrl(): string | undefined {
  return MACRO.NATIVE_PACKAGE_URL || process.env.NCODE_NATIVE_PACKAGE_URL
}

export const GITHUB_RELEASES_API_URL =
  process.env.NCODE_GITHUB_RELEASES_API_URL ??
  'https://api.github.com/repos/Noumena-Network/code/releases'

type GithubReleaseAsset = {
  browser_download_url?: string
  name?: string
}

type GithubRelease = {
  assets?: GithubReleaseAsset[]
  draft?: boolean
  prerelease?: boolean
  tag_name?: string
}

function normalizeVersionTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}

function releaseVersionFromTag(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag
}

function getGithubReleaseApiHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function findGithubAsset(
  release: GithubRelease,
  assetName: string,
): GithubReleaseAsset {
  const asset = release.assets?.find(candidate => candidate.name === assetName)
  if (!asset?.browser_download_url) {
    throw new Error(
      `GitHub release ${release.tag_name ?? 'unknown'} is missing asset ${assetName}`,
    )
  }
  return asset
}

async function getGithubReleaseByTag(version: string): Promise<GithubRelease> {
  const tag = normalizeVersionTag(version)
  const response = await axios.get<GithubRelease>(
    `${GITHUB_RELEASES_API_URL}/tags/${encodeURIComponent(tag)}`,
    {
      timeout: 30000,
      responseType: 'json',
      headers: getGithubReleaseApiHeaders(),
    },
  )
  return response.data
}

export async function getLatestVersionFromGithubReleases(
  channel: ReleaseChannel = 'latest',
): Promise<string> {
  const startTime = Date.now()
  try {
    const response = await axios.get<GithubRelease[]>(GITHUB_RELEASES_API_URL, {
      timeout: 30000,
      responseType: 'json',
      headers: getGithubReleaseApiHeaders(),
      params: { per_page: 25 },
    })
    const release = response.data.find(candidate => {
      if (candidate.draft) return false
      if (channel === 'stable' && candidate.prerelease) return false
      return Boolean(candidate.tag_name)
    })
    if (!release?.tag_name) {
      throw new Error(`No ${channel} GitHub release is available`)
    }
    logEvent('ncode_version_check_success', {
      latency_ms: Date.now() - startTime,
      source_github_releases: true,
    })
    return releaseVersionFromTag(release.tag_name)
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }
    logEvent('ncode_version_check_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
      source_github_releases: true,
    })
    const fetchError = new Error(
      `Failed to fetch ${channel} version from GitHub releases: ${errorMessage}`,
    )
    logError(fetchError)
    throw fetchError
  }
}
export async function getLatestVersionFromBinaryRepo(
  channel: ReleaseChannel = 'latest',
  baseUrl: string,
  authConfig?: { auth: { username: string; password: string } },
): Promise<string> {
  const startTime = Date.now()
  try {
    const response = await axios.get(`${baseUrl}/${channel}`, {
      timeout: 30000,
      responseType: 'text',
      ...authConfig,
    })
    const latencyMs = Date.now() - startTime
    logEvent('ncode_version_check_success', {
      latency_ms: latencyMs,
    })
    return response.data.trim()
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }

    logEvent('ncode_version_check_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
    })
    const fetchError = new Error(
      `Failed to fetch version from ${baseUrl}/${channel}: ${errorMessage}`,
    )
    logError(fetchError)
    throw fetchError
  }
}

export async function getLatestVersion(
  channelOrVersion: string,
): Promise<string> {
  // Direct version - match internal format too (e.g. 1.0.30-dev.shaf4937ce)
  if (/^v?\d+\.\d+\.\d+(-\S+)?$/.test(channelOrVersion)) {
    const normalized = channelOrVersion.startsWith('v')
      ? channelOrVersion.slice(1)
      : channelOrVersion
    // 99.99.x is reserved for CI smoke-test fixtures on real GCS.
    // feature() is false in all shipped builds — DCE collapses this to an
    // unconditional throw. Only `bun --feature=ALLOW_TEST_VERSIONS` (the
    // smoke test's source-level invocation) bypasses.
    if (/^99\.99\./.test(normalized) && !feature('ALLOW_TEST_VERSIONS')) {
      throw new Error(
        `Version ${normalized} is not available for installation. Use 'stable' or 'latest'.`,
      )
    }
    return normalized
  }

  // ReleaseChannel validation
  const channel = channelOrVersion as ReleaseChannel
  if (channel !== 'stable' && channel !== 'latest') {
    throw new Error(
      `Invalid channel: ${channelOrVersion}. Use 'stable' or 'latest'`,
    )
  }

  const binaryRepoUrl = getPublicBinaryUrl()
  if (binaryRepoUrl) {
    return getLatestVersionFromBinaryRepo(channel, binaryRepoUrl)
  }

  return getLatestVersionFromGithubReleases(channel)
}

// Stall timeout: abort if no bytes received for this duration
const DEFAULT_STALL_TIMEOUT_MS = 60000 // 60 seconds
const MAX_DOWNLOAD_RETRIES = 3

function getStallTimeoutMs(): number {
  return (
    Number(process.env.CLAUDE_CODE_STALL_TIMEOUT_MS_FOR_TESTING) ||
    DEFAULT_STALL_TIMEOUT_MS
  )
}

class StallTimeoutError extends Error {
  constructor() {
    super('Download stalled: no data received for 60 seconds')
    this.name = 'StallTimeoutError'
  }
}

/**
 * Common logic for downloading and verifying a binary.
 * Includes stall detection (aborts if no bytes for 60s) and retry logic.
 */
async function downloadAndVerifyBinary(
  binaryUrl: string,
  expectedChecksum: string,
  binaryPath: string,
  requestConfig: Record<string, unknown> = {},
) {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    const controller = new AbortController()
    let stallTimer: ReturnType<typeof setTimeout> | undefined

    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer)
        stallTimer = undefined
      }
    }

    const resetStallTimer = () => {
      clearStallTimer()
      stallTimer = setTimeout(c => c.abort(), getStallTimeoutMs(), controller)
    }

    try {
      // Start the stall timer before the request
      resetStallTimer()

      const response = await axios.get(binaryUrl, {
        timeout: 5 * 60000, // 5 minute total timeout
        responseType: 'arraybuffer',
        signal: controller.signal,
        onDownloadProgress: () => {
          // Reset stall timer on each chunk of data received
          resetStallTimer()
        },
        ...requestConfig,
      })

      clearStallTimer()

      // Verify checksum
      const hash = createHash('sha256')
      hash.update(response.data)
      const actualChecksum = hash.digest('hex')

      if (actualChecksum !== expectedChecksum) {
        throw new Error(
          `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
        )
      }

      // Write binary to disk
      await writeFile(binaryPath, Buffer.from(response.data))
      await chmod(binaryPath, 0o755)

      // Success - return early
      return
    } catch (error) {
      clearStallTimer()

      // Check if this was a stall timeout (axios wraps abort signals in CanceledError)
      const isStallTimeout = axios.isCancel(error)

      if (isStallTimeout) {
        lastError = new StallTimeoutError()
      } else {
        lastError = toError(error)
      }

      // Only retry on stall timeouts
      if (isStallTimeout && attempt < MAX_DOWNLOAD_RETRIES) {
        logForDebugging(
          `Download stalled on attempt ${attempt}/${MAX_DOWNLOAD_RETRIES}, retrying...`,
        )
        // Brief pause before retry to let network recover
        await sleep(1000)
        continue
      }

      // Don't retry other errors (HTTP errors, checksum mismatches, etc.)
      throw lastError
    }
  }

  // Should not reach here, but just in case
  throw lastError ?? new Error('Download failed after all retries')
}

export async function downloadVersionFromGithubRelease(
  version: string,
  stagingPath: string,
) {
  const fs = getFsImplementation()

  await fs.rm(stagingPath, { recursive: true, force: true })

  const platform = getPlatform()
  const binaryName = getBinaryName(platform)
  const artifactBaseName = `ncode-${version}-${platform}`
  const zipAssetName = `${artifactBaseName}.zip`
  const checksumAssetName = `${zipAssetName}.sha256`
  const startTime = Date.now()

  logEvent('ncode_binary_download_attempt', { source_github_releases: true })

  const release = await getGithubReleaseByTag(version)
  const zipAsset = findGithubAsset(release, zipAssetName)
  const checksumAsset = findGithubAsset(release, checksumAssetName)

  const checksumResponse = await axios.get(checksumAsset.browser_download_url!, {
    timeout: 30000,
    responseType: 'text',
  })
  const expectedChecksum = String(checksumResponse.data).trim().split(/\s+/)[0]
  if (!expectedChecksum) {
    throw new Error(`GitHub release asset ${checksumAssetName} did not contain a checksum`)
  }

  const zipResponse = await axios.get(zipAsset.browser_download_url!, {
    timeout: 5 * 60000,
    responseType: 'arraybuffer',
  })
  const zipBuffer = Buffer.from(zipResponse.data)
  const actualChecksum = createHash('sha256').update(zipBuffer).digest('hex')
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Checksum mismatch for ${zipAssetName}: expected ${expectedChecksum}, got ${actualChecksum}`,
    )
  }

  const entries = unzipSync(new Uint8Array(zipBuffer))
  const binaryEntry =
    entries[`${artifactBaseName}/${binaryName}`] ?? entries[binaryName]
  if (!binaryEntry) {
    throw new Error(`GitHub release asset ${zipAssetName} did not contain ${binaryName}`)
  }

  await fs.mkdir(stagingPath)
  const binaryPath = join(stagingPath, binaryName)
  await writeFile(binaryPath, Buffer.from(binaryEntry))
  await chmod(binaryPath, 0o755)

  logEvent('ncode_binary_download_success', {
    latency_ms: Date.now() - startTime,
    source_github_releases: true,
  })
}

export async function downloadVersionFromBinaryRepo(
  version: string,
  stagingPath: string,
  baseUrl: string,
  authConfig?: {
    auth?: { username: string; password: string }
    headers?: Record<string, string>
  },
) {
  const fs = getFsImplementation()

  // If we get here, we own the lock and can delete a partial download
  await fs.rm(stagingPath, { recursive: true, force: true })

  // Get platform
  const platform = getPlatform()
  const startTime = Date.now()

  // Log download attempt start
  logEvent('ncode_binary_download_attempt', {})

  // Fetch manifest to get checksum
  let manifest
  try {
    const manifestResponse = await axios.get(
      `${baseUrl}/${version}/manifest.json`,
      {
        timeout: 10000,
        responseType: 'json',
        ...authConfig,
      },
    )
    manifest = manifestResponse.data
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }

    logEvent('ncode_binary_manifest_fetch_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
    })
    logError(
      new Error(
        `Failed to fetch manifest from ${baseUrl}/${version}/manifest.json: ${errorMessage}`,
      ),
    )
    throw error
  }

  const platformInfo = manifest.platforms[platform]

  if (!platformInfo) {
    logEvent('ncode_binary_platform_not_found', {})
    throw new Error(
      `Platform ${platform} not found in manifest for version ${version}`,
    )
  }

  const expectedChecksum = platformInfo.checksum

  // Both GCS and generic bucket use identical layout: ${baseUrl}/${version}/${platform}/${binaryName}
  const binaryName = getBinaryName(platform)
  const binaryUrl = `${baseUrl}/${version}/${platform}/${binaryName}`

  // Write to staging
  await fs.mkdir(stagingPath)
  const binaryPath = join(stagingPath, binaryName)

  try {
    await downloadAndVerifyBinary(
      binaryUrl,
      expectedChecksum,
      binaryPath,
      authConfig || {},
    )
    const latencyMs = Date.now() - startTime
    logEvent('ncode_binary_download_success', {
      latency_ms: latencyMs,
    })
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)
    let httpStatus: number | undefined
    if (axios.isAxiosError(error) && error.response) {
      httpStatus = error.response.status
    }

    logEvent('ncode_binary_download_failure', {
      latency_ms: latencyMs,
      http_status: httpStatus,
      is_timeout: errorMessage.includes('timeout'),
      is_checksum_mismatch: errorMessage.includes('Checksum mismatch'),
    })
    logError(
      new Error(`Failed to download binary from ${binaryUrl}: ${errorMessage}`),
    )
    throw error
  }
}

export async function downloadVersion(
  version: string,
  stagingPath: string,
): Promise<'npm' | 'binary'> {
  // Test-fixture versions route to the private sentinel bucket. DCE'd in all
  // shipped builds — the sentinel string and the gcloud call never exist in
  // compiled binaries. Same gcloud-token pattern as
  // remoteSkillLoader.ts:175-195.
  if (feature('ALLOW_TEST_VERSIONS') && /^99\.99\./.test(version)) {
    const { stdout } = await execFileNoThrowWithCwd('gcloud', [
      'auth',
      'print-access-token',
    ])
    await downloadVersionFromBinaryRepo(
      version,
      stagingPath,
      'https://storage.googleapis.com/ncode-ci-sentinel',
      { headers: { Authorization: `Bearer ${stdout.trim()}` } },
    )
    return 'binary'
  }

  const binaryRepoUrl = getPublicBinaryUrl()
  if (binaryRepoUrl) {
    await downloadVersionFromBinaryRepo(version, stagingPath, binaryRepoUrl)
    return 'binary'
  }

  await downloadVersionFromGithubRelease(version, stagingPath)
  return 'binary'
}

// Exported for testing
export { StallTimeoutError, MAX_DOWNLOAD_RETRIES }
export const STALL_TIMEOUT_MS = DEFAULT_STALL_TIMEOUT_MS
export const _downloadAndVerifyBinaryForTesting = downloadAndVerifyBinary
