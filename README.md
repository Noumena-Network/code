# Noumena Code

Noumena Code is an AI coding assistant that runs from your terminal. It can inspect a codebase, edit files, run commands, and help carry multi-step development workflows.

## Quick Start

```bash
git clone https://github.com/noumena-network/code.git
cd code
bun install
bun run build
```

The default build creates a native single-file `ncode` binary. The build command prints JSON with the exact `binaryPath`; on Linux x64 the default path is:

```bash
.tmp/packages/ncode-0.1.0-linux-x64/ncode
```

Run it directly:

```bash
.tmp/packages/ncode-0.1.0-linux-x64/ncode --help
```

## Login

The canonical way to use Noumena-managed accounts is OAuth:

```bash
.tmp/packages/ncode-0.1.0-linux-x64/ncode auth login
```

Complete the browser OAuth flow. You can also start the app and run `/login` from inside the REPL.

Noumena API keys and BYOK are supported alternatives for automation and direct-provider workflows:

```bash
NOUMENA_API_KEY=... .tmp/packages/ncode-0.1.0-linux-x64/ncode
ANTHROPIC_API_KEY=... .tmp/packages/ncode-0.1.0-linux-x64/ncode
```

The launcher also reads `~/.config/noumena/ncode/api_key` by default. Service endpoints can be overridden for non-default infrastructure:

```bash
NOUMENA_BASE_URL=https://api.noumena.com
NOUMENA_PLATFORM_BASE_URL=https://api.noumena.com
NOUMENA_OAUTH_WEB_BASE_URL=https://code.noumena.com
```

## Model selection

The current OSS build ships public first-party managed profiles for Kimi 2.7 Coder and GLM 5.2. You must select one explicitly; ncode does not silently switch your session to a managed model if you have not chosen one.

Use the `--model` flag when starting ncode:

```bash
.tmp/packages/ncode-0.1.0-linux-x64/ncode --model kimi-2.7-coder
.tmp/packages/ncode-0.1.0-linux-x64/ncode --model glm-5.2
```

Or run `/model` inside the REPL and pick `Kimi 2.7 Coder` or `GLM 5.2`.

Recognized Kimi aliases include `kimi-2.7-coder`, `k2.7`, `kimi-2.7`, and `kimi 2.7 coder`.
Recognized GLM aliases include `glm-5.2`, `glm52`, `glm 5.2`, `glm-5.2-fp8`, and `glm52-fp8`.
You can also set `NOUMENA_MODEL=kimi-2.7-coder` or `NOUMENA_MODEL=glm-5.2` in your environment.

## Requirements

Build requirements:

- Node.js 18 or newer
- Bun 1.3.10 or newer
- Rust 1.80 or newer (with `cargo` on `PATH`)

Developer test requirements:

- `tmux` for PTY/tmux integration tests
- A normal interactive Unix-like terminal environment for wrapper and terminal-rendering contracts

Install Bun and Rust with their upstream installers:

```bash
curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

After installing, open a new shell or ensure `bun`, `cargo`, and, for tests, `tmux` are on `PATH`.


## Tests

The full Bun test suite is intentionally isolated: each `*.test.*` file runs in a fresh Bun process so global environment and auth caches cannot leak across files. This is slower than a single `bun test` process. Some PTY, tmux, native-package, and rendering-contract tests can take a long time and may build the native binary on demand.

```bash
bun run test
```

For focused work, run a single test file directly:

```bash
bun test src/path/to/file.test.ts
```

If you do not have `tmux`, install it before running the full suite; otherwise tmux-backed integration tests will fail or be skipped depending on the local environment.

## Current Release Limitations

- Packaged release binaries currently use the tested `sharp` fallback path for image processing instead of `image-processor-napi`. The native package available in the OSS dependency tree is a reserved stub, not a loadable native implementation. This is tracked in [#42](https://github.com/Noumena-Network/code/issues/42).

## Build Output

`bun run build` is the preferred user build. It packages the CLI as a native binary and writes artifacts under `.tmp/packages/`:

- `binaryPath`: native executable
- `manifestPath`: package manifest and checksum metadata
- `zipPath`: distributable archive

The source bundle `dist/cli.js` is for development, not the preferred user-facing build artifact.

## Advanced Build Modes

Choose a build mode before building; the mode is baked into the binary.

| Mode | Command | Intended use |
| --- | --- | --- |
| `external` | `bun run build:external` | Default OSS build. Public-safe gates, Noumena OAuth, Noumena API keys, and BYOK. |
| `noumena` | `bun run build:noumena` | Noumena first-party/product build with Noumena compatibility features enabled. |
| `dev` | `bun run build:dev` | Contributor/debug build that enables development/internal capability gates. |
| `internal` | `bun run build:internal` | Internal compatibility spin for Noumena-controlled environments. |

Set the build mode at build time with `NCODE_USER_TYPE`:

```bash
# Default OSS build (public-safe gates).
NCODE_USER_TYPE=external bun run build

# Noumena first-party build (enables managed-model aliases, first-party UI
# surfaces, and other Noumena compatibility features).
NCODE_USER_TYPE=noumena bun run build
```

`NCODE_USER_TYPE` is baked into the binary; it controls compile-time feature gates such as `BUILD_SPIN` and `isInternalBuild()`. The `noumena`/`internal`/`dev` spins are not available in an `external` binary without rebuilding.

### Runtime feature switches

Some capabilities are gated at runtime so a single build can expose different behavior without recompiling:

```bash
# Enables all Noumena first-party/hidden product features that are safe for
# external users but left off by default (e.g. managed model aliases,
# first-party UI surfaces, experimental Noumena integrations).
NCODE_USER_MODE=noumena

# Uses the native OpenAI-compatible WebSocket v2 transport. This is the fastest
# and most reliable inference path for Noumena-managed models.
NCODE_OPENAI_COMPAT_WS_V2=1
```

These can be combined depending on your account type and preferred inference transport. Note that `NCODE_OPENAI_COMPAT_WS_V2` is a runtime switch only — the WS2 native module must already be present in the built binary, which it is for all default build modes.

Explicit package commands are also available:

```bash
bun run package:compiled:external -- --target bun-linux-x64
bun run package:compiled:noumena -- --target bun-linux-x64
bun run package:compiled:dev -- --target bun-linux-x64
bun run package:compiled:internal -- --target bun-linux-x64
```

Supported single-executable targets are documented in [OSS_BUILD.md](OSS_BUILD.md).

## Source Development

For source-level development without packaging a native binary:

```bash
bun run build:source
./ncode --help
```

This writes `dist/cli.js` and uses the `./ncode` development launcher.

## Repository Scope

This repository is the standalone public source export of `code/` from Noumena's internal monorepo. It intentionally excludes monorepo-only Buck/Sapling integration, generated build outputs, vendored dependencies, staging launchers, and internal planning/parity notes.

This export keeps the source needed to build and develop the public CLI:

- `src/` TypeScript and React/Ink application source
- `build/` Bun build and packaging scripts
- `native/` Rust N-API modules
- `scripts/` public install and utility scripts
- `docs/` public design notes

Excluded content includes `node_modules`, `dist`, `.tmp`, monorepo `mlstore` mirrors, Buck files, staging launchers, and internal launch/parity/reconstruction documents.

## License

Apache-2.0. See [LICENSE](LICENSE).
