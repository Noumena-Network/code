// Regression guard for oven-sh/bun#28742: Bun's bundler renamer can produce
// identifier collisions when `identifiers: true` minification is enabled.
// Two distinct free variables get the same mangled name, so a call like
// `<callable>(<callable>)` crashes at runtime with "X is not a function"
// where X is an instance of Object — not a function. Reported in our issue
// #36; same crash signature as Sentry CLI's bypass.
//
// This script builds the bundle with the UNSAFE minify profile
// ({ whitespace: true, identifiers: true }) and exits non-zero if the
// resulting bundle contains a parameter-self-call collision pattern.
//
// It exists so re-enabling identifier mangling in SAFE_STANDALONE_MINIFY
// is gated on proof the upstream bug (oven-sh/bun#28742, fix attempt
// #30272 still open) is resolved.
//
// The guard is intentionally brittle: if it ever passes, EITHER the
// mangler is fixed (safe to re-enable `identifiers: true` in build.mjs)
// OR the current bundle's identifier count happens to dodge the collision
// (in which case the test gives false confidence — that's why the
// production profile stays whitespace-only even when this passes).
//
// Run: bun build/minifierCollisionGuard.mjs
// Exit: 0 on no collision, 1 on collision (with diagnostic).

import { rm } from 'node:fs/promises'
import {
  buildBundleWithMinify,
  findCollisions,
} from './minifierCollisionGuardHelper.mjs'

const { source, outDir, forensicPath } = await buildBundleWithMinify(
  { whitespace: true, identifiers: true },
  'guard',
)

try {
  if (source.length === 0) {
    throw new Error('Built bundle is empty — something went wrong with the build.')
  }

  const collisions = findCollisions(source)

  if (collisions.length === 0) {
    console.log(
      `minifier-guard: PASS — no parameter-self-call collisions in ` +
        `${source.length} byte bundle (built with identifiers: true).`,
    )
    process.exit(0)
  }

  const descriptions = collisions.map(c => `"${c.slice(0, 100)}..."`)
  console.error(
    `minifier-guard: FAIL — ${collisions.length} parameter-self-call ` +
      `collision pattern(s) detected (oven-sh/bun#28742).\n` +
      `Bundle contains:\n${descriptions.join('\n')}\n\n` +
      `This means \`identifiers: true\` in SAFE_STANDALONE_MINIFY ` +
      `(build/build.mjs) is unsafe on current Bun and CANNOT be ` +
      `re-enabled. Failing bundle saved at ${forensicPath}.\n\n` +
      `Upstream: oven-sh/bun#28742, fix attempt #30272 still open.`,
  )
  process.exit(1)
} catch (err) {
  console.error('minifier-guard: ERROR —', err?.message ?? err)
  process.exit(2)
} finally {
  await rm(outDir, { recursive: true, force: true })
}