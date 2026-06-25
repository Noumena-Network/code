# Changelog

All notable changes to Noumena Code are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

See [RELEASING.md](./RELEASING.md) for the release process and version-bump policy.

## [Unreleased]

## [0.2.0] - 2026-06-25

### Added

- GitHub Actions now build, attest, and publish Linux and macOS release artifacts from version tags on `main`.
- Load `AGENTS.md` and `.agents/` instructions into context via the `agentsmd` loader ([#15](https://github.com/Noumena-Network/code/pull/15))
- GLM 5.2 managed first-party model profile and tier routing ([#17](https://github.com/Noumena-Network/code/pull/17))
- GLM 5.2 promoted to the first-party default model ([#21](https://github.com/Noumena-Network/code/pull/21))
- `cliPrint` / `cliPrintWarn` / `cliPrintError` helpers in `src/utils/cliOutput.ts` — thin pass-throughs to `process.stdout` / `process.stderr` that centralize the `noConsole` lint suppression in one place rather than at ~248 scattered `biome-ignore` comments. Unlike `cliError` / `cliOk` in `src/cli/exit.ts`, these do NOT exit the process. 241 of 248 suppressions migrated (97%); the 7 remaining are genuine special cases (crash handler, global console patch, entrypoint fast-paths, dev-mode warnings, central helpers).
- `swallow(promise, context)` helper in `src/utils/swallow.ts` — fire-and-forget promise wrapper that logs rejections at debug level via `logForDebugging` before suppressing them, making silent failures observable when debugging without propagating as `unhandledRejection`.
- `clearAllBaseToolsCache()` export in `src/tools.ts` and a `registerDownstreamCacheInvalidator()` registration mechanism in `src/utils/plugins/pluginLoader.ts` — `tools.ts` registers its clearer at module-eval time via lazy `require` (avoids the circular dependency), and `clearPluginCache()` now transitively busts the `allBaseToolsCache` so plugin reloads and `NCODE_USER_MODE` runtime switches return a fresh tool set instead of a stale singleton.
- `src/ink/reconcilerShims.ts` — centralized type augmentations for `react-reconciler@0.33.0` runtime APIs (`updateContainerSync`, `flushSyncWork`, `flushSyncFromReconciler`, and the 10-arg `createContainer` arity) that ship in the package but are missing from `@types/react-reconciler`. Exports `asSyncReconciler()` and `asCreateContainer10()` wrappers; all Ink call sites import from here so type suppressions live in a single file.
- Shared `isToolConcurrencySafe(tool, rawInput)` helper in `src/services/tools/toolConcurrency.ts` — extracts the duplicated parse + try/catch + `tool.isConcurrencySafe(parsedInput.data)` fallback that was implemented independently in both `toolOrchestration.ts` and `StreamingToolExecutor.ts`. Both call sites now use the shared helper.

### Changed

- Release workflow now supports build-only dry-runs before publishing tags, and release docs now describe required branch protection and known native image fallback status.
- Public first-party builds now default to Kimi K2.7 Coder ([#4](https://github.com/Noumena-Network/code/pull/4))
- Migrated 77 `process.env.NCODE_BUILD_MODE === 'noumena' || process.env.USER_TYPE === 'ant'` direct env reads across 57 files to the canonical `isInternalBuild()` / `!isInternalBuild()` helper from `src/capabilities/static.ts`. The helper is a strict superset of the legacy check (also returns true for `internal` and `dev` spins), matching its documented contract "Returns true for any non-public spin". `TungstenTool`-specific `USER_TYPE === 'noumena'` gates (a distinct concept — Noumena product user, not internal build) are intentionally left untouched.
- Migrated 241 `biome-ignore lint/suspicious/noConsole` suppressions across 19 files to use the new `cliPrint` / `cliPrintWarn` / `cliPrintError` helpers: `plugins.ts` (36), `mcp.tsx` (25), `bridgeMain.ts` (19), `setup.ts` (9), `main.tsx` (9), `pluginCliCommands.ts` (7), `auth.ts` (5), `client.ts` (4), `worktree.ts` (3), `agents.ts` (3), `windowsPaths.ts` (2), `betas.ts` (2), `autoUpdater.ts` (2), `protocolHandler.ts` (2), `fileHistory.ts` (1), `process.ts` (1), `shell/prefix.ts` (1), `structuredIO.ts` (1+1 unguarded), `imageProcessor.ts` (1). The 7 remaining suppressions are genuine special cases (crash handler, global console patch, entrypoint fast-paths, dev-mode warnings, central helpers).
- Migrated 19 silent fire-and-forget `.catch(() => {})` promises across `main.tsx` (6), `bridge/replBridge.ts` (1), `bridge/replBridgeHandle.ts` (1), `services/mcp/client.ts` (5), `tools/FileReadTool` (1), `tools/FileEditTool` (1), `tools/FileWriteTool` (1), `services/analytics/firstPartyEventLogger.ts` (1), `services/api/claude.ts` (1), `services/api/openAICompatInferenceClient.ts` (1) to the new `swallow(promise, context)` helper. The remaining ~33 sites are `await ... .catch(() => {})` patterns (which wait for the promise), `Promise.race` losers, or map-attach patterns — these need different treatment and are left for a follow-up.
- Removed unnecessary `.mode as PermissionMode` cast in `QueryEngine.ts:570` — `AppStateStore` types `toolPermissionContext` as `ToolPermissionContext`, whose `.mode` field is already `PermissionMode`. The cast was a stale leftover from when `mode` was typed looser.
- `src/utils/modifiers.ts` rewritten to use `createRequire` + cached `loadBinding()` with try/catch (matching the pattern in `src/shims/audioCaptureNapi.ts`) instead of a top-level `require('modifiers-napi')`. The require is now lazy — only fires when `isModifierPressed` / `prewarmModifiers` is called on macOS — so the bundler doesn't try to resolve it at build time and the build no longer fails when the stub package is absent.

### Fixed

- Standalone release builds now disable Bun identifier minification to avoid runtime name-collision crashes ([#36](https://github.com/Noumena-Network/code/issues/36)).
- Native `sharp` embedding build for macOS and other non-Linux targets ([#1](https://github.com/Noumena-Network/code/pull/1))
- Tool-call cancellation reason text on parallel tool cancellation ([#13](https://github.com/Noumena-Network/code/pull/13))
- NCode config and credentials are now isolated from Claude Code state on disk ([#11](https://github.com/Noumena-Network/code/pull/11))
- Managed first-party tier routing and per-tier pricing lookup ([#27](https://github.com/Noumena-Network/code/pull/27))
- Launcher no longer forces all tiers to the default model at startup ([#29](https://github.com/Noumena-Network/code/pull/29))
- `readFileState` seeding from transcript now skips failed `Write` calls instead of poisoning the cache ([#30](https://github.com/Noumena-Network/code/pull/30))
- GLM 5.2 1M context lane support and tier lookup ([#31](https://github.com/Noumena-Network/code/pull/31))
- Package smoke probe now normalizes executable paths through `realpath()` so macOS `/var` vs `/private/var` does not false-fail the native runtime probe ([#28](https://github.com/Noumena-Network/code/pull/28))
- Prompt-injection warning guidance tightened to require concrete evidence before warning the user; the malware-mitigation reminder is no longer appended to every benign file-read result ([#32](https://github.com/Noumena-Network/code/pull/32))
- `allBaseToolsCache` in `src/tools.ts` (a module-level singleton that never invalidated) now busts when `clearPluginCache()` runs. Previously, plugin reloads mid-session or `NCODE_USER_MODE` runtime switches would return a stale tool set that excluded newly-registered plugin tools.
- Build no longer fails when the `modifiers-napi` stub package is absent. The top-level `require('modifiers-napi')` in `src/utils/modifiers.ts` was a static require that the bundler tried to resolve at build time; rewritten to lazy `createRequire` + cache so it only fires on macOS at call time.
- JWT payload decode failures in `src/bridge/jwtUtils.ts` now log the token prefix and error message at debug level (previously silently returned `null`, hiding malformed-token diagnostics that are security-relevant).
- `decodeURIComponent` failures in `src/tools/LSPTool/LSPTool.ts` now log the path prefix and error at debug level (previously silently fell through to the un-decoded path).
- `image-processor-napi` load failures in `src/tools/FileReadTool/imageProcessor.ts` now log the error before falling back to `sharp` (surfaces native-module loading issues that were previously invisible).
- `agentMemorySnapshot` read/parse failures in `src/tools/AgentTool/agentMemorySnapshot.ts` now log the path and error at debug level (helps diagnose corrupt memory snapshot files).
- Bare `// TODO: fix this` in `src/screens/REPL.tsx:3554` above the `eslint-disable react-hooks/exhaustive-deps` replaced with a documentation comment explaining why `[]` deps is correct for the mount-once effect (stable refs).
- `// TODO: figure out why` in `src/services/api/errorUtils.ts:126` resolved — API error messages can be undefined when the error originates from a network failure (no HTTP response body to parse) or a non-JSON error envelope. Replaced with a documentation comment.
- `// TODO: Refactor to use isMemoryFilePath()` in `src/services/compact/compact.ts:1765` resolved — added `isMemoryFilePath()` check alongside the existing `MEMORY_TYPE_VALUES` canonical-path check. `isMemoryFilePath()` checks by basename + path pattern, catching child directory memory files (`.ncode/rules/*.md`, `.claude/rules/*.md`) that the canonical-path check misses. Both checks kept for completeness.

### Removed

- **Dead stub N-API packages** (`image-processor-napi`, `color-diff-napi`, `modifiers-napi`, `url-handler-napi`) removed from `package.json` `dependencies`. Each was a `0.0.1` reserved-stub package whose entire implementation was `module.exports = {}` — zero runtime value. All consumers wrap their `import()` / `require()` in try/catch and fall through to working alternatives (`sharp`, `osascript`, no-op). `audio-capture-napi` is intentionally kept — `build/build.mjs` shims its import specifier to `src/shims/audioCaptureNapi.ts`, which loads a real native binding from `@anthropic-ai/claude-agent-sdk/vendor/audio-capture/`.
- **Orphaned `rust/py_repl_host/`** crate (491 lines of Rust + `Cargo.toml` + `Cargo.lock` + `assets/kernel.py`) and the `src/shims/assets/pyReplHost.ts` shim removed. `build/build.mjs:75-76` explicitly documents that "py_repl is intentionally not bundled in the OSS export"; the `PyReplTool` is gated off by `isInternalBuild()` and never registered in external builds; the leftover `BUCK` file was a monorepo artifact (AGENTS.md: "This repo uses Git, not Sapling/Buck").
- **Stale `/mlstore/src/noumena/` path** removed from `build/packageAudit.mjs` static forbidden-substring list. This was an internal-monorepo checkout path that leaked into the public export; the dynamic `collectLocalPathForbiddenSubstrings()` already covers the current checkout path at runtime.
- 11 `@ts-expect-error` comments across `src/ink/ink.tsx` (6) and `src/ink/render-to-screen.ts` (5) that suppressed missing `@types/react-reconciler` declarations for `updateContainerSync`, `flushSyncWork`, `flushSyncFromReconciler`, and the 10-arg `createContainer` arity. Centralized in the new `src/ink/reconcilerShims.ts`.
- 98 `biome-ignore lint/suspicious/noConsole:: intentional console output` comments across 5 high-traffic CLI files (replaced by the new `cliPrint` / `cliPrintWarn` / `cliPrintError` helpers).

### Docs

- `AGENTS.md` and `CLAUDE.md` added to document OSS agent safety boundaries ([#7](https://github.com/Noumena-Network/code/pull/7))
- `NCODE_USER_TYPE` build mode and runtime feature switches documented ([#6](https://github.com/Noumena-Network/code/pull/6))
- Minimum Rust version (1.80) documented for build tooling ([#9](https://github.com/Noumena-Network/code/pull/9))
- README updated to instruct users to explicitly select Kimi K2.7 Coder for first-party builds ([#14](https://github.com/Noumena-Network/code/pull/14))
- Bare `// TODO: avoid the cast` in `src/utils/promptCategory.ts:21` replaced with a documented explanation of why the `as QuerySource` cast exists (`QuerySource` is a closed string union; built-in agent types are dynamic template literals TS can't prove are union members) and what would fix it (widen `QuerySource` to a template literal type or add `agent:builtin:${string}` as a member).

## [0.1.0] - 2026-06-16

Initial OSS export of Noumena Code.

[Unreleased]: https://github.com/Noumena-Network/code/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Noumena-Network/code/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Noumena-Network/code/releases/tag/v0.1.0