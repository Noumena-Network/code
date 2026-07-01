# Building ncode from source

This guide is for users who want to build `ncode` outside the Noumena monorepo. Most users should start with the prebuilt binary below.

## Supported prebuilt binaries

As of this release we can only ship one well-tested prebuilt:

- `linux-x64` glibc, built on Ubuntu 24.04

If your host matches that target, use the release download and run `ncode install` to set up the launcher.

## When to build from source

Build from source if you are on:

- macOS (Intel or Apple Silicon)
- Linux ARM64
- Linux with a musl-based distribution
- Any Linux distribution that is binary-incompatible with our Ubuntu 24.04 build

## Requirements

- [Bun](https://bun.sh) 1.3.10 or newer
- [Rust](https://rustup.rs) 1.80 or newer (with `cargo` on `PATH`)
- `curl` or `wget` (only for the install helper)

You do not need the rest of the Noumena monorepo or Sapling/Buck2.

## Native Build Modes

`ncode` bakes its build mode at bundle time. Choose the mode before building; setting `NCODE_USER_TYPE` only when running an already-built binary does not switch modes.

The default user-facing build produces a native single-file binary under `.tmp/packages/`.

| Mode | Command | Notes |
| --- | --- | --- |
| `external` | `bun run build:external` | Default OSS/public-safe mode. Supports Noumena OAuth, Noumena API keys, and BYOK without enabling internal-only gates. |
| `noumena` | `bun run build:noumena` | Noumena first-party/product mode. Enables Noumena compatibility features and first-party feature gates. |
| `dev` | `bun run build:dev` | Development spin for contributors who need debug/internal gates while working from source. |
| `internal` | `bun run build:internal` | Internal compatibility spin for Noumena-controlled environments. Not the recommended public default. |

For one-off native packages, you can call the package script directly:

```bash
NCODE_USER_TYPE=external bun build/package.mjs --build-mode external
NCODE_USER_TYPE=noumena bun build/package.mjs --build-mode noumena
NCODE_USER_TYPE=dev bun build/package.mjs --build-mode dev
NCODE_USER_TYPE=internal bun build/package.mjs --build-mode internal
```

For source-level development, use the Bun bundle scripts instead:

```bash
bun run build:source:external
bun run build:source:noumena
bun run build:source:dev
bun run build:source:internal
```

Those write `dist/cli.js` for the `./ncode` development launcher. They are not the preferred user-facing build artifact.

## Build

The `code/` directory is self-contained. Copy or clone it to a fresh location and build the default external native binary:

```bash
cd code
bun install
bun run build
```

This compiles the native Rust modules required by the CLI and packages a single-file executable. The package script prints JSON with the exact paths, including:

- `binaryPath`: native executable
- `manifestPath`: package manifest and checksum metadata
- `zipPath`: distributable archive

The default Linux x64 artifact path is:

```bash
.tmp/packages/ncode-0.1.0-linux-x64/ncode
```

If `cargo` is not available, the build is not considered complete.

## Login

The canonical login path for Noumena-managed accounts is OAuth:

```bash
.tmp/packages/ncode-0.1.0-linux-x64/ncode auth login
```

You can also run the app and type `/login` in the REPL. Complete the browser OAuth flow to connect the local CLI to your Noumena-managed account.

Noumena API keys and BYOK remain supported for automation and direct-provider workflows. Noumena OAuth login is optional and independent from inference provider selection:

```bash
NOUMENA_API_KEY=... .tmp/packages/ncode-0.1.0-linux-x64/ncode
ANTHROPIC_API_KEY=... .tmp/packages/ncode-0.1.0-linux-x64/ncode
OPENAI_API_KEY=... OPENAI_BASE_URL=https://openrouter.ai/api/v1 OPENAI_MODEL=inclusionai/ling-2.6-flash .tmp/packages/ncode-0.1.0-linux-x64/ncode
```

Direct key precedence is `NOUMENA_API_KEY`, then `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`. Project settings cannot silently set OpenAI BYOK routing variables.

## Run locally

Run the native binary produced by `bun run build`:

```bash
.tmp/packages/ncode-0.1.0-linux-x64/ncode --help
```

For source-level development without packaging a binary:

```bash
bun run build:source
./ncode --help
```

To install into `~/.local/bin` with shell integration:

```bash
.tmp/packages/ncode-0.1.0-linux-x64/ncode install
```

## Package

`bun run build` is an alias for the default external package command. The current supported targets are:

- `bun-linux-x64`
- `bun-linux-x64-musl`
- `bun-darwin-x64`
- `bun-darwin-arm64`

Choose a target explicitly when needed:

```bash
bun run package:compiled:external -- --target bun-linux-x64
bun run package:compiled:noumena -- --target bun-linux-x64
bun run package:compiled:dev -- --target bun-linux-x64
bun run package:compiled:internal -- --target bun-linux-x64
```

## Known limitations

1. The dev wrapper `code/ncode` dispatches workspace lifecycle commands (`ncode create|delete|reap|list`) to `../tools/bootstrap/ncode_workspace_cli.sh`. The bootstrap tooling is not part of the self-contained `code/` release, so those commands are not available outside the monorepo.
2. The smoke-test suite references files under `../tools/smoke/` and can only run from the monorepo root.
3. macOS ARM64 and musl binaries must be built on matching hosts; we do not cross-compile them in CI yet.
4. `flags.noumena.com` (GrowthBook) is optional at build and run time. Without it, the CLI falls back to build-time feature flags and per-call defaults. A simpler remote flag server is planned; for now the product runs correctly without GrowthBook.
