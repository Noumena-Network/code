# Changelog

All notable changes to Noumena Code are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

See [RELEASING.md](./RELEASING.md) for the release process and version-bump policy.

## [Unreleased]

### Added

- GitHub Actions now build, attest, and publish Linux and macOS release artifacts from version tags on `main`.
- Load `AGENTS.md` and `.agents/` instructions into context via the `agentsmd` loader ([#15](https://github.com/Noumena-Network/code/pull/15))
- GLM 5.2 managed first-party model profile and tier routing ([#17](https://github.com/Noumena-Network/code/pull/17))
- GLM 5.2 promoted to the first-party default model ([#21](https://github.com/Noumena-Network/code/pull/21))

### Changed

- Public first-party builds now default to Kimi K2.7 Coder ([#4](https://github.com/Noumena-Network/code/pull/4))

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

### Docs

- `AGENTS.md` and `CLAUDE.md` added to document OSS agent safety boundaries ([#7](https://github.com/Noumena-Network/code/pull/7))
- `NCODE_USER_TYPE` build mode and runtime feature switches documented ([#6](https://github.com/Noumena-Network/code/pull/6))
- Minimum Rust version (1.80) documented for build tooling ([#9](https://github.com/Noumena-Network/code/pull/9))
- README updated to instruct users to explicitly select Kimi K2.7 Coder for first-party builds ([#14](https://github.com/Noumena-Network/code/pull/14))

## [0.1.0] - 2026-06-16

Initial OSS export of Noumena Code.

[Unreleased]: https://github.com/Noumena-Network/code/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Noumena-Network/code/releases/tag/v0.1.0