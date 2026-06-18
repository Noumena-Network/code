import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  formatFindings,
  getDefaultAllowlist,
  runExposureAudit,
} from '../src/constants/repoExposureAudit.ts';
import { buildStandaloneExecutable } from './build.mjs';
import {
  buildCompiledPackage,
  SINGLE_EXECUTABLE_MINIFY,
} from './package.mjs';

const FORBIDDEN_MANIFEST_KEYS = [
  'packageDir',
  'binaryPath',
  'manifestPath',
  'zipPath',
];
const EXPECTED_IMAGE_PROCESSOR_FALLBACK_WARNING =
  'Native image processor not available, falling back to sharp';

function parseArgs(argv) {
  const args = {
    outDir: undefined,
    target: undefined,
    runBinaryChecks: true,
    runNativeProbe: true,
    keepOutput: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out-dir') {
      args.outDir = path.resolve(argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--target') {
      args.target = argv[index + 1];
      index += 1;
    } else if (arg === '--no-run') {
      args.runBinaryChecks = false;
      args.runNativeProbe = false;
    } else if (arg === '--no-native-probe') {
      args.runNativeProbe = false;
    } else if (arg === '--keep-output') {
      args.keepOutput = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function runBinary(command) {
  const startedAt = Date.now();
  const proc = Bun.spawn({
    cmd: command,
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): ${command.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  return {
    stdout,
    stderr,
    elapsedMs: Date.now() - startedAt,
  };
}

function expectLinesInOrder(lines, expectedLines, label) {
  let searchIndex = 0;

  for (const expectedLine of expectedLines) {
    let found = false;
    for (let index = searchIndex; index < lines.length; index += 1) {
      if (lines[index]?.includes(expectedLine)) {
        searchIndex = index;
        found = true;
        break;
      }
    }

    if (!found) {
      throw new Error(
        `Expected ${label} to include line containing ${JSON.stringify(expectedLine)} in order.\nLines:\n${lines.join('\n')}`,
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceAuditFindings = runExposureAudit({
    allowlist: getDefaultAllowlist(),
  });
  if (sourceAuditFindings.length > 0) {
    throw new Error(
      `Repo source exposure audit failed before build:\n${formatFindings(sourceAuditFindings)}`,
    );
  }

  const tempRoot = args.outDir ??
    await mkdtemp(path.join(os.tmpdir(), 'ncode-package-smoke-'));

  try {
    const result = await buildCompiledPackage({
      outDir: tempRoot,
      buildMode: 'noumena',
      target: args.target,
    });

    let versionResult = null;
    let helpResult = null;
    let probeResult = null;

    if (args.runBinaryChecks) {
      versionResult = await runBinary([
      result.binaryPath,
      '--version',
      ]);
      if (versionResult.stderr.trim().length > 0) {
        throw new Error(
          `Compiled binary --version wrote to stderr:\n${versionResult.stderr}`,
        );
      }
      if (!new RegExp(`^${result.version} \\(NCode\\)$`).test(versionResult.stdout.trim())) {
        throw new Error(
          `Compiled binary version output did not match expected contract: ${versionResult.stdout}`,
        );
      }
      if (versionResult.elapsedMs > 2_000) {
        throw new Error(
          `Compiled binary --version exceeded fast-path budget: ${versionResult.elapsedMs}ms`,
        );
      }

      helpResult = await runBinary([
      result.binaryPath,
      '--help',
      ]);
      if (helpResult.stderr.trim().length > 0) {
        throw new Error(
          `Compiled binary --help wrote to stderr:\n${helpResult.stderr}`,
        );
      }
      const helpLines = helpResult.stdout
        .split('\n')
        .map(line => line.trimEnd())
        .filter(line => line.trim().length > 0);
      expectLinesInOrder(helpLines, ['Usage: ncode', 'Options:'], 'compiled binary --help output');
      if (helpResult.elapsedMs > 4_000) {
        throw new Error(
          `Compiled binary --help exceeded fast-path budget: ${helpResult.elapsedMs}ms`,
        );
      }
    }

    const packageEntries = (await readdir(result.packageDir)).sort();
    const expectedEntries = ['manifest.json', path.basename(result.binaryPath)].sort();
    if (JSON.stringify(packageEntries) !== JSON.stringify(expectedEntries)) {
      throw new Error(
        `Single-executable package contained unexpected files: ${packageEntries.join(', ')}`,
      );
    }

    const manifest = await Bun.file(
      path.join(result.packageDir, 'manifest.json'),
    ).json();
    const leakedManifestKeys = FORBIDDEN_MANIFEST_KEYS.filter(key =>
      Object.prototype.hasOwnProperty.call(manifest, key),
    );
    if (leakedManifestKeys.length > 0) {
      throw new Error(
        `Shipped manifest leaked local path keys: ${leakedManifestKeys.join(', ')}`,
      );
    }

    if (!result.securityAudit?.ok) {
      throw new Error('Compiled package did not report a successful security audit.');
    }

    if (args.runNativeProbe) {
      const probeBinaryPath = path.join(tempRoot, 'ncode-package-native-probe');
      await buildStandaloneExecutable({
        outfile: probeBinaryPath,
        buildMode: 'noumena',
        target: result.compileTarget,
        entrypoint: 'src/entrypoints/packageSmoke.ts',
        minify: SINGLE_EXECUTABLE_MINIFY,
      });

      const probeExecution = await runBinary([probeBinaryPath]);
      if (probeExecution.stderr.trim().length > 0) {
        throw new Error(
          `Native runtime probe wrote to stderr:\n${probeExecution.stderr}`,
        );
      }
      probeResult = JSON.parse(probeExecution.stdout);
      if (!probeResult.ok) {
        throw new Error(`Native runtime probe failed: ${probeExecution.stdout}`);
      }
      if (probeResult.bundledMode !== true) {
        throw new Error(
          `Native runtime probe was not in bundled mode: ${JSON.stringify(probeResult)}`,
        );
      }
      if (probeResult.runningWithBun !== true) {
        throw new Error(
          `Native runtime probe did not report Bun runtime: ${JSON.stringify(probeResult)}`,
        );
      }
      const [expectedExecPath, actualExecPath] = await Promise.all([
        realpath(probeBinaryPath),
        realpath(probeResult.execPath),
      ]);
      if (actualExecPath !== expectedExecPath) {
        throw new Error(
          `Native runtime probe execPath mismatch. Expected ${expectedExecPath}, got ${actualExecPath}`,
        );
      }
      if (!Array.isArray(probeResult.imageProcessorWarnings)) {
        throw new Error(
          `Native runtime probe did not report imageProcessorWarnings as an array: ${JSON.stringify(probeResult)}`,
        );
      }
      if (!['native', 'sharp-fallback'].includes(probeResult.imageProcessorMode)) {
        throw new Error(
          `Native runtime probe reported unexpected imageProcessorMode: ${JSON.stringify(probeResult)}`,
        );
      }
      if (
        !probeResult.ripgrep ||
        typeof probeResult.ripgrep.path !== 'string' ||
        !probeResult.ripgrep.version?.startsWith('ripgrep ') ||
        typeof probeResult.ripgrep.filesCount !== 'number' ||
        probeResult.ripgrep.filesCount <= 0
      ) {
        throw new Error(
          `Native runtime probe reported invalid ripgrep contract: ${JSON.stringify(probeResult)}`,
        );
      }
      if (probeResult.imageProcessorMode === 'native') {
        if (probeResult.imageProcessorWarnings.length > 0) {
          throw new Error(
            `Native runtime probe reported warnings while claiming native image processor mode: ${JSON.stringify(probeResult)}`,
          );
        }
      } else if (
        JSON.stringify(probeResult.imageProcessorWarnings) !==
        JSON.stringify([EXPECTED_IMAGE_PROCESSOR_FALLBACK_WARNING])
      ) {
        throw new Error(
          `Native runtime probe reported unexpected image processor fallback warnings: ${JSON.stringify(probeResult)}`,
        );
      }
    }

    if (!result.zipPath) {
      throw new Error('Compiled package zip archive was not generated.');
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          binaryPath: result.binaryPath,
          zipPath: result.zipPath,
          securityAudit: result.securityAudit,
          versionCheck: {
            elapsedMs: versionResult?.elapsedMs ?? null,
          },
          helpCheck: {
            elapsedMs: helpResult?.elapsedMs ?? null,
          },
          nativeProbe: probeResult,
        },
        null,
        2,
      ),
    );
  } finally {
    if (!args.keepOutput && !args.outDir) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

await main();
