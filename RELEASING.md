# Releasing Noumena Code

This document describes the versioning standard, changelog discipline, and release-cut process for the `code` package.

## Standards

- **Versioning:** [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
- **Changelog format:** [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
- **Commit messages:** [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)

`package.json` carries a single `version` field that is the source of truth for what the build ships.

## Version-Bump Policy

While the major version is `0`, the rules below apply. Once `1.0.0` is cut, strict SemVer 2.0.0 takes over and the pre-1.0 carve-out is retired.

| Change type           | Prefix          | Bump       | CHANGELOG section |
| --------------------- | --------------- | ---------- | ----------------- |
| New user-facing feature | `feat(scope):` | `0.x.0` → `0.(x+1).0` | Added   |
| Breaking behavior fix | `fix(scope)!:`  | `0.x.0` → `0.(x+1).0` | Changed / Removed |
| Bug fix               | `fix(scope):`   | `0.x.y` → `0.x.(y+1)` | Fixed  |
| Docs / build-only     | `docs:`, `chore:` | no bump   | Docs              |

For changes that span multiple categories, pick the largest bump among them.

## Changelog Discipline

Every user-visible change goes under `## [Unreleased]` in [CHANGELOG.md](./CHANGELOG.md) under one of these subsections:

- **Added** — new user-facing capability
- **Changed** — existing behavior changed in a way users may notice
- **Deprecated** — soon-to-be removed feature
- **Removed** — now-removed feature
- **Fixed** — bug fix
- **Security** — vulnerability or security-posture change

Each entry is one line, in past tense, ending with the PR link in parentheses. Internal-only refactors, test additions, and pure-build changes that don't affect users do **not** get a CHANGELOG entry.

Build-only fixes that block user build (e.g. native module build failures across a platform) do get an entry under Fixed — they affect whether the package runs at all.

## Cutting a Release

1. Confirm `## [Unreleased]` in `CHANGELOG.md` reflects every merged PR since the last release. Pull from the PR history if anything is missing.
2. Decide the bump based on the policy above.
3. Move the contents of `## [Unreleased]` into a new `## [VERSION] - YYYY-MM-DD` section immediately below the `## [Unreleased]` header. Leave `## [Unreleased]` empty.
4. Bump `version` in `package.json` to the new version.
5. Add a comparison link at the bottom of `CHANGELOG.md` for the new tag, e.g. `[0.2.0]: https://github.com/Noumena-Network/code/compare/v0.1.0...v0.2.0`.
6. Commit on a `release/VERSION` branch with the message `chore(release): vX.Y.Z`.
7. Open a PR. Do not tag or publish until the PR merges.
8. After merge, create and push tag `vX.Y.Z` on the merge commit on `main`. The GitHub Actions release workflow validates the tag, builds Linux and macOS artifacts, and publishes the GitHub release. Release notes are pulled from the `## [VERSION]` section verbatim.

The release workflow currently publishes:

- `ncode-VERSION-linux-x64.zip` from `ubuntu-24.04` (`bun-linux-x64`)
- `ncode-VERSION-darwin-arm64.zip` from `macos-14` (`bun-darwin-arm64`)
- `ncode-VERSION-darwin-x64.zip` from `macos-15-intel` (`bun-darwin-x64`)
- matching `.sha256` checksum files and `.manifest.json` files for each artifact
- GitHub artifact attestations for the release assets

Tags must point to commits reachable from `origin/main`, must match `package.json` (`v${version}`), and must have a matching `CHANGELOG.md` release section.

If a revert is needed between tag and publish, delete the tag, revert the release commit, and re-cut. If a published release is bad, create a new patch release rather than mutating the released asset in place.

## Pre-1.0 Expectations

Until `1.0.0` is cut, the public API may change between minor versions. Callers should pin to a specific version. There is no long-term-support branch.