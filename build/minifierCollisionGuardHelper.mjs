// Helper used by minifierCollisionGuard.test.ts.
// Builds the bundle with a given minify profile and writes the JS output
// to a temp file, returning the path. Kept as a separate .mjs so the JSX
// entrypoint resolves through Bun.build()'s loaders — not through `bun test`'s
// import resolution.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'os'
import { createBundlerOptions, resolveBuildSettings } from './build.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

export async function buildBundleWithMinify(minifyProfile, label = 'unnamed') {
  const settings = await resolveBuildSettings({ buildMode: 'external' })
  const outDir = await mkdtemp(path.join(tmpdir(), `ncode-minifier-${label}-`))

  try {
    const result = await Bun.build(
      createBundlerOptions(settings, {
        outdir: outDir,
        minify: minifyProfile,
        sourcemap: 'none',
      }),
    )

    if (!result.success) {
      const logs = result.logs.map(l => String(l)).join('\n')
      throw new Error(`Bundle build failed:\n${logs}`)
    }

    const jsOutput = result.outputs.find(o => o.path.endsWith('.js'))
    if (!jsOutput) {
      throw new Error('Bundle build produced no .js output')
    }

    const source = await jsOutput.text()
    const forensicPath = path.join(outDir, 'bundle.js')
    await writeFile(forensicPath, source)

    return {
      source,
      outDir,
      forensicPath,
    }
  } catch (err) {
    await rm(outDir, { recursive: true, force: true })
    throw err
  }
}

// Collision signatures from issue #36 and oven-sh/bun#28742:
//   function Name(a, b) { const x = a(a) ...
//   function Name(a) { const x = a(a) ...
//   var foo = function(a, b) { const x = a(a) ...
//   (a, b) => { const x = a(a) ...
// The shared shape is: a function's first parameter called with itself
// as the first argument. This is never valid in real code — it would
// mean calling a parameter that hasn't been assigned yet, which is
// either a no-op or a crash.
export const COLLISION_PATTERNS = [
  /function\s+\w+\((\w+),\s*\w+\)\s*\{\s*const\s+\w+\s*=\s*\1\(\1\)/,
  /function\s+\w+\((\w+)\)\s*\{\s*const\s+\w+\s*=\s*\1\(\1\)/,
  /var\s+\w+\s*=\s*function\s*\((\w+),\s*\w+\)\s*\{\s*const\s+\w+\s*=\s*\1\(\1\)/,
  /\((\w+),\s*\w+\)\s*=>\s*\{\s*const\s+\w+\s*=\s*\1\(\1\)/,
]

export function findCollisions(source) {
  return COLLISION_PATTERNS
    .map(p => p.exec(source))
    .filter(Boolean)
    .map(m => m[0])
}