import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { auditCompiledPackage } from './packageAudit.mjs';
import {
  buildStandaloneExecutable,
  SAFE_STANDALONE_MINIFY,
} from './build.mjs';

const buildDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(buildDir, '..');
const packageJson = JSON.parse(
  await Bun.file(path.join(rootDir, 'package.json')).text(),
);
export const SINGLE_EXECUTABLE_MINIFY = SAFE_STANDALONE_MINIFY;
const SUPPORTED_SINGLE_EXECUTABLE_TARGETS = new Set([
  'bun-linux-x64',
  'bun-linux-x64-musl',
  'bun-darwin-x64',
  'bun-darwin-arm64',
]);

function parseArgs(argv) {
  const args = {
    outDir: path.join(rootDir, '.tmp', 'packages'),
    buildMode:
      process.env.NCODE_USER_TYPE ??
      'external',
    binaryName: undefined,
    target: undefined,
    skipArchive: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out-dir') {
      args.outDir = path.resolve(argv[index + 1] ?? args.outDir);
      index += 1;
    } else if (arg === '--target') {
      args.target = argv[index + 1];
      index += 1;
    } else if (arg === '--build-mode') {
      args.buildMode = argv[index + 1] ?? args.buildMode;
      index += 1;
    } else if (arg === '--binary-name') {
      args.binaryName = argv[index + 1];
      index += 1;
    } else if (arg === '--skip-archive') {
      args.skipArchive = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function isMuslHost() {
  const report = process.report?.getReport?.();
  const glibcVersionRuntime = report?.header?.glibcVersionRuntime;
  return process.platform === 'linux' && !glibcVersionRuntime;
}

export function detectHostCompileTarget() {
  const osPart =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  const archPart = process.arch === 'arm64' ? 'arm64' : 'x64';
  const libcPart =
    osPart === 'linux' && isMuslHost() ? '-musl' : '';
  return `bun-${osPart}-${archPart}${libcPart}`;
}

export function getTargetInfo(requestedTarget) {
  const compileTarget = requestedTarget ?? detectHostCompileTarget();
  const parts = compileTarget.split('-');
  if (parts.length < 3 || parts[0] !== 'bun') {
    throw new Error(
      `Unsupported Bun compile target: ${compileTarget}`,
    );
  }

  const osPart = parts[1];
  const archPart = parts[2];
  const platformPart =
    osPart === 'windows'
      ? 'win32'
      : osPart === 'darwin'
        ? 'darwin'
        : 'linux';

  return {
    compileTarget,
    slug: compileTarget.replace(/^bun-/, ''),
    platformPart,
    archPart,
    binaryName:
      platformPart === 'win32' ? 'ncode.exe' : 'ncode',
  };
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function walkFiles(rootPath, currentPath = rootPath) {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(rootPath, absolutePath)));
    } else if (entry.isFile()) {
      files.push({
        absolutePath,
        relativePath: path.relative(rootPath, absolutePath),
      });
    }
  }
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function createZipFromDirectory(sourceDir, zipPath) {
  const archiveEntries = {};
  for (const file of await walkFiles(sourceDir)) {
    archiveEntries[file.relativePath] = new Uint8Array(
      await readFile(file.absolutePath),
    );
  }

  const zipped = zipSync(archiveEntries, { level: 9 });
  await writeFile(zipPath, Buffer.from(zipped));
}

function assertSupportedSingleExecutableTarget(targetInfo) {
  if (SUPPORTED_SINGLE_EXECUTABLE_TARGETS.has(targetInfo.compileTarget)) {
    return;
  }

  throw new Error(
    [
      `Single-executable packaging is only wired for ${Array.from(SUPPORTED_SINGLE_EXECUTABLE_TARGETS).join(', ')} right now.`,
      `Requested target: ${targetInfo.compileTarget}.`,
      'The current blocker is packaging native runtime assets for unsupported platforms.',
    ].join(' '),
  );
}

export async function buildCompiledPackage(options = {}) {
  const parsed = {
    outDir: options.outDir
      ? path.resolve(options.outDir)
      : path.join(rootDir, '.tmp', 'packages'),
    buildMode:
      options.buildMode ??
      process.env.NCODE_USER_TYPE ??
      'external',
    target: options.target,
    binaryName: options.binaryName,
    skipArchive: options.skipArchive ?? false,
  };

  const targetInfo = getTargetInfo(parsed.target);
  assertSupportedSingleExecutableTarget(targetInfo);

  const binaryName =
    parsed.binaryName ?? targetInfo.binaryName;
  const artifactBaseName = `ncode-${packageJson.version}-${targetInfo.slug}`;
  const packageDir = path.join(parsed.outDir, artifactBaseName);
  const binaryPath = path.join(packageDir, binaryName);
  const zipPath = path.join(parsed.outDir, `${artifactBaseName}.zip`);

  await rm(packageDir, { recursive: true, force: true });
  if (!parsed.skipArchive) {
    await rm(zipPath, { force: true });
  }
  await mkdir(packageDir, { recursive: true });

  await buildStandaloneExecutable({
    outfile: binaryPath,
    buildMode: parsed.buildMode,
    target: targetInfo.compileTarget,
    // SAFE_STANDALONE_MINIFY intentionally keeps syntax and identifier
    // minification disabled. Syntax minification has fused `return` with
    // helper identifiers in this CLI, and identifier minification has produced
    // runtime name collisions (issue #36, upstream oven-sh/bun#28742).
    // Whitespace-only minification is the current safe profile for the real
    // single-executable CLI.
    minify: SINGLE_EXECUTABLE_MINIFY,
  });

  const manifest = {
    artifactName: artifactBaseName,
    version: packageJson.version,
    buildMode: parsed.buildMode,
    compileTarget: targetInfo.compileTarget,
    binaryName,
    entrypoint: binaryName,
    embeddedRuntime: {
      audioCapture: true,
      markdownRenderer: true,
      sharp: true,
    },
    compileOptions: {
      minify: SINGLE_EXECUTABLE_MINIFY,
    },
    checksums: {
      binary: await sha256(binaryPath),
    },
  };

  const manifestPath = path.join(packageDir, 'manifest.json');
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  if (!parsed.skipArchive) {
    await createZipFromDirectory(packageDir, zipPath);
  }

  const securityAudit = await auditCompiledPackage({
    packageDir,
    binaryPath,
    manifestPath,
  });

  return {
    ...manifest,
    packageDir,
    binaryPath,
    securityAudit,
    manifestPath,
    zipPath: parsed.skipArchive ? null : zipPath,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildCompiledPackage(args);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await main();
}
