import { existsSync } from 'node:fs';
import {
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const buildDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(buildDir, '..');
const outDir = path.join(rootDir, 'dist');
const outFile = path.join(outDir, 'cli.js');
const bundledEntryFile = path.join(outDir, 'src', 'entrypoints', 'cli.js');
const bundledEntryMapFile = `${bundledEntryFile}.map`;
const outMapFile = `${outFile}.map`;
// Identifier mangling (`identifiers: true`) is disabled because Bun's
// bundler renamer can produce runtime identifier collisions in large bundles.
// In issue #36, the standalone CLI contained `function Hg(H4, $) { const A =
// H4(H4); ... }`, where a parameter shadowed the function binding and crashed
// at startup with `H4 is not a function`.
//
// Upstream tracking: oven-sh/bun#28742 documents the same collision class, and
// oven-sh/bun#30272 is the open compiler fix. Re-enable identifier mangling only
// after that fix ships and packageSmoke's manifest guard is updated deliberately.
export const SAFE_STANDALONE_MINIFY = {
  whitespace: true,
  identifiers: false,
};
const vendorSources = [
  {
    source: path.join(
      rootDir,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'vendor',
      'ripgrep',
    ),
    destination: path.join(outDir, 'vendor', 'ripgrep'),
  },
];
const baseBuildFeatures = [
  'TRANSCRIPT_CLASSIFIER',
  'KAIROS_BRIEF',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'VERIFICATION_AGENT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'CCR_REMOTE_SETUP',
  'BUDDY',
  'BRIDGE_MODE',
  'VOICE_MODE',
  'ULTRAPLAN',
];
const noumenaModeBuildFeatures = [
  'KAIROS',
  'HISTORY_SNIP',
  'WORKFLOW_SCRIPTS',
  'KAIROS_GITHUB_WEBHOOKS',
  'TORCH',
  'UDS_INBOX',
  'FORK_SUBAGENT',
];

const NATIVE_RENDERER_CRATE_STEM = 'markdown_renderer_napi';
const NATIVE_RENDERER_ARTIFACT_NAME = 'markdown-renderer-napi.node';
const WS_V2_NATIVE_CRATE_STEM = 'openai_compat_ws_v2_napi';
const WS_V2_NATIVE_ARTIFACT_NAME = 'openai-compat-ws-v2-napi.node';
// py_repl is intentionally not bundled in the OSS export. Public builds do not
// stage or embed a Python REPL host.
const INLINE_SOURCE_MAP_TRAILER_RE =
  /\n\/\/# sourceMappingURL=data:application\/json[^\n]*\s*$/g;
const SANITIZED_STANDALONE_ROOT = '/__ncode_bundle_root__';

function getNativeRendererReleaseArtifactCandidates() {
  return getCdylibArtifactCandidates(NATIVE_RENDERER_CRATE_STEM);
}

function getWsV2NativeReleaseArtifactCandidates() {
  return getCdylibArtifactCandidates(WS_V2_NATIVE_CRATE_STEM);
}

function getCdylibArtifactCandidates(crateStem) {
  return [
    `lib${crateStem}.so`,
    `lib${crateStem}.dylib`,
    `${crateStem}.dll`,
    `lib${crateStem}.dll`,
  ];
}

function findFirstExistingPath(paths) {
  for (const candidate of paths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveCargoTargetDirectory(rootDir, manifestPath, nativePackageDir) {
  try {
    const metadata = Bun.spawnSync({
      cmd: [
        'cargo',
        'metadata',
        '--format-version',
        '1',
        '--no-deps',
        '--manifest-path',
        manifestPath,
      ],
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (metadata.exitCode !== 0 || !metadata.stdout) {
      return path.join(nativePackageDir, 'target');
    }
    const parsed = JSON.parse(metadata.stdout.toString());
    const targetDirectory =
      parsed && typeof parsed.target_directory === 'string'
        ? parsed.target_directory
        : null;
    return targetDirectory ?? path.join(nativePackageDir, 'target');
  } catch {
    return path.join(nativePackageDir, 'target');
  }
}

function getCargoBuildEnv(rootDir) {
  const env = { ...process.env };
  const repoRoot = path.resolve(rootDir, '..');
  const homeDir = process.env.HOME ? path.resolve(process.env.HOME) : null;
  const remapPairs = [
    [rootDir, SANITIZED_STANDALONE_ROOT],
    [repoRoot, '/__ncode_repo_root__'],
  ];

  if (homeDir) {
    remapPairs.push([homeDir, '/__ncode_home__']);
    remapPairs.push([path.join(homeDir, '.cargo'), '/__ncode_cargo_home__']);
    remapPairs.push([path.join(homeDir, '.rustup'), '/__ncode_rustup_home__']);
  }

  const remapFlags = remapPairs
    .filter(([fromPath]) => !!fromPath)
    .map(([fromPath, toPath]) => `--remap-path-prefix=${fromPath}=${toPath}`);

  if (remapFlags.length > 0) {
    env.RUSTFLAGS = [env.RUSTFLAGS, ...remapFlags].filter(Boolean).join(' ');
  }

  return env;
}


async function buildNativeCdylib({
  rootDir,
  nativePackageRelativeDir,
  artifactName,
  artifactCandidates,
}) {
  const nativePackageDir = path.join(rootDir, nativePackageRelativeDir);
  const manifestPath = path.join(nativePackageDir, 'Cargo.toml');
  const targetDir = resolveCargoTargetDirectory(
    rootDir,
    manifestPath,
    nativePackageDir,
  );
  const releaseDir = path.join(targetDir, 'release');
  const distDir = path.join(nativePackageDir, 'dist');
  const destinationPath = path.join(distDir, artifactName);

  if (!existsSync(manifestPath)) {
    return {
      built: false,
      reason: `manifest missing at ${path.relative(rootDir, manifestPath)}`,
    };
  }

  try {
    const cargoBuild = Bun.spawn({
      cmd: ['cargo', 'build', '--release', '--manifest-path', manifestPath],
      cwd: rootDir,
      env: getCargoBuildEnv(rootDir),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await cargoBuild.exited;
    if (exitCode !== 0) {
      return {
        built: false,
        reason: `cargo build exited with code ${exitCode}`,
      };
    }
  } catch (error) {
    return {
      built: false,
      reason: `cargo build failed to start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const sourcePath = findFirstExistingPath(
    artifactCandidates.map(file => path.join(releaseDir, file)),
  );
  if (!sourcePath) {
    return {
      built: false,
      reason: `no native artifact found in ${path.relative(rootDir, releaseDir)}`,
    };
  }

  await mkdir(distDir, { recursive: true });
  await copyFile(sourcePath, destinationPath);

  return {
    built: true,
    destinationPath,
  };
}

async function buildNativeMarkdownRenderer(rootDir) {
  return buildNativeCdylib({
    rootDir,
    nativePackageRelativeDir: path.join('native', 'markdown-renderer-napi'),
    artifactName: NATIVE_RENDERER_ARTIFACT_NAME,
    artifactCandidates: getNativeRendererReleaseArtifactCandidates(),
  });
}

async function buildNativeOpenAICompatWsV2(rootDir) {
  return buildNativeCdylib({
    rootDir,
    nativePackageRelativeDir: path.join('native', 'openai-compat-ws-v2-napi'),
    artifactName: WS_V2_NATIVE_ARTIFACT_NAME,
    artifactCandidates: getWsV2NativeReleaseArtifactCandidates(),
  });
}

function resolveSourceImport(specifier) {
  if (!specifier.startsWith('src/')) {
    return null;
  }

  const absolutePath = path.join(rootDir, specifier);
  const parsed = path.parse(absolutePath);
  const candidates = [];

  if (parsed.ext === '.js') {
    candidates.push(
      path.join(parsed.dir, `${parsed.name}.ts`),
      path.join(parsed.dir, `${parsed.name}.tsx`),
      absolutePath,
      path.join(parsed.dir, `${parsed.name}.jsx`),
    );
  } else if (parsed.ext.length > 0) {
    candidates.push(absolutePath);
  } else {
    candidates.push(
      `${absolutePath}.ts`,
      `${absolutePath}.tsx`,
      `${absolutePath}.js`,
      `${absolutePath}.jsx`,
      path.join(absolutePath, 'index.ts'),
      path.join(absolutePath, 'index.tsx'),
      path.join(absolutePath, 'index.js'),
      path.join(absolutePath, 'index.jsx'),
    );
  }

  return candidates.find(candidate => existsSync(candidate)) ?? absolutePath;
}

const srcAliasPlugin = {
  name: 'src-alias',
  setup(build) {
    build.onResolve({ filter: /^src\// }, args => ({
      path: resolveSourceImport(args.path),
    }));
  },
};

const privatePackageShimPlugin = {
  name: 'private-package-shims',
  setup(build) {
    build.onResolve(
      { filter: /^@ant\/claude-for-chrome-mcp$/ },
      () => ({
        path: path.join(rootDir, 'src', 'shims', 'claudeForChromeMcp.ts'),
      }),
    );
  },
};

// Maps a compile-target slug (the `bun-` prefix stripped) to the sharp binding
// shim that embeds that platform's native addon + libvips. Each shim only
// statically imports the assets for its own platform, because Bun only installs
// the `@img/sharp-*` optional dependencies matching the build host's os/cpu —
// importing another platform's assets would fail to resolve at bundle time.
const SHARP_BINDING_BY_TARGET = {
  'linux-x64': 'sharpBinding.cjs',
  'linux-x64-musl': 'sharpBinding.cjs',
  'darwin-arm64': 'sharpBinding.darwin-arm64.cjs',
  'darwin-x64': 'sharpBinding.darwin-x64.cjs',
};

function resolveSharpBindingPath(sharpTargetSlug) {
  const bindingFile = SHARP_BINDING_BY_TARGET[sharpTargetSlug];
  if (!bindingFile) {
    throw new Error(
      `No bundled sharp native runtime for target "${sharpTargetSlug}". ` +
        `Supported targets: ${Object.keys(SHARP_BINDING_BY_TARGET).join(', ')}.`,
    );
  }
  return path.join(rootDir, 'src', 'shims', 'sharp', bindingFile);
}

function createRuntimeNativeShimPlugin(sharpTargetSlug) {
  return {
    name: 'runtime-native-shims',
    setup(build) {
      build.onResolve({ filter: /^audio-capture-napi$/ }, () => ({
        path: path.join(rootDir, 'src', 'shims', 'audioCaptureNapi.ts'),
      }));

      build.onResolve({ filter: /^\.\/sharp$/ }, args => {
        const normalizedImporter = args.importer.replace(/\\/g, '/');
        if (normalizedImporter.includes('/node_modules/sharp/lib/')) {
          return {
            path: resolveSharpBindingPath(sharpTargetSlug),
          };
        }
        return null;
      });
    },
  };
}

const inlineSourceMapStripPlugin = {
  name: 'inline-source-map-strip',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
      const relativePath = path.relative(rootDir, args.path);
      if (
        relativePath.startsWith('..') ||
        relativePath.includes(`node_modules${path.sep}`)
      ) {
        return null;
      }

      const contents = await readFile(args.path, 'utf8');
      if (!contents.includes('sourceMappingURL=data:application/json')) {
        return null;
      }

      const ext = path.extname(args.path);
      const loader =
        ext === '.tsx'
          ? 'tsx'
          : ext === '.ts'
            ? 'ts'
            : ext === '.jsx'
              ? 'jsx'
              : 'js';

      return {
        contents: contents.replace(INLINE_SOURCE_MAP_TRAILER_RE, ''),
        loader,
      };
    });
  },
};

function isMuslBuildHost() {
  const report = process.report?.getReport?.();
  const glibcVersionRuntime = report?.header?.glibcVersionRuntime;
  return process.platform === 'linux' && !glibcVersionRuntime;
}

// Derives the sharp asset target slug from a requested Bun compile target
// (e.g. `bun-darwin-arm64` -> `darwin-arm64`). When no target is requested
// (source builds, local standalone builds), fall back to the build host so the
// embedded native assets always match the machine the bundle will run on.
function resolveSharpTargetSlug(requestedTarget) {
  if (requestedTarget) {
    return requestedTarget.replace(/^bun-/, '');
  }
  const osPart =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  const archPart = process.arch === 'arm64' ? 'arm64' : 'x64';
  const libcPart = osPart === 'linux' && isMuslBuildHost() ? '-musl' : '';
  return `${osPart}-${archPart}${libcPart}`;
}

function getBuildMode(requestedUserType) {
  const buildMode =
    requestedUserType === 'noumena' || requestedUserType === 'n'
      ? 'noumena'
      : requestedUserType;
  return {
    buildMode,
    isNoumenaMode: buildMode === 'noumena',
  };
}

export async function resolveBuildSettings(options = {}) {
  const packageJson = JSON.parse(
    await Bun.file(path.join(rootDir, 'package.json')).text(),
  );
  const requestedUserType =
    options.buildMode ??
    process.env.NCODE_USER_TYPE ??
    'external';
  const { buildMode, isNoumenaMode } = getBuildMode(requestedUserType);
  const userType = isNoumenaMode ? 'noumena' : requestedUserType;
  const internalCompatibilityBuild = isNoumenaMode || userType === 'ant';
  const buildFeatures = [...baseBuildFeatures];

  if (internalCompatibilityBuild) {
    buildFeatures.push('BREAK_CACHE_COMMAND', 'PERFETTO_TRACING');
  }

  if (isNoumenaMode) {
    buildFeatures.push(...noumenaModeBuildFeatures);
  }

  const version =
    process.env.NCODE_VERSION ??
    packageJson.version;
  const buildTime =
    process.env.NCODE_BUILD_TIME ??
    '2026-03-29T01:39:21Z';
  const packageUrl =
    process.env.NCODE_PACKAGE_URL ??
    packageJson.name;
  const nativePackageUrl =
    process.env.NCODE_NATIVE_PACKAGE_URL;
  const versionChangelog =
    process.env.NCODE_VERSION_CHANGELOG ??
    '';
  const issuesUrl =
    packageJson.bugs?.url ??
    'https://github.com/noumena/ncode.cc/issues';
  const issuesExplainer =
    process.env.NCODE_ISSUES_EXPLAINER ??
    `report the issue at ${issuesUrl}`;
  const feedbackChannel =
    process.env.NCODE_FEEDBACK_CHANNEL ??
    issuesUrl;
  const chromeMcpPackagePath = path.join(
    rootDir,
    'node_modules',
    '@ant',
    'claude-for-chrome-mcp',
  );
  const hasChromeMcpPackage = existsSync(chromeMcpPackagePath);
  const verifyPlan =
    process.env.NCODE_VERIFY_PLAN ??
    process.env.CLAUDE_CODE_VERIFY_PLAN ??
    (internalCompatibilityBuild ? 'true' : 'false');

  return {
    packageJson,
    buildMode,
    userType,
    buildFeatures,
    hasChromeMcpPackage,
    sharpTargetSlug: resolveSharpTargetSlug(options.target),
    define: {
      'process.env.USER_TYPE': JSON.stringify(userType),
      'process.env.NCODE_BUILD_MODE': JSON.stringify(buildMode),
      'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify(verifyPlan),
      'process.env.NODE_ENV': JSON.stringify('production'),
      'MACRO.VERSION': JSON.stringify(version),
      'MACRO.BUILD_TIME': JSON.stringify(buildTime),
      'MACRO.PACKAGE_URL': JSON.stringify(packageUrl),
      'MACRO.NATIVE_PACKAGE_URL': nativePackageUrl
        ? JSON.stringify(nativePackageUrl)
        : 'undefined',
      'MACRO.FEEDBACK_CHANNEL': JSON.stringify(feedbackChannel),
      'MACRO.VERSION_CHANGELOG': JSON.stringify(versionChangelog),
      'MACRO.ISSUES_EXPLAINER': JSON.stringify(issuesExplainer),
    },
  };
}

function createBuildPlugins(settings) {
  const plugins = [
    srcAliasPlugin,
    createRuntimeNativeShimPlugin(settings.sharpTargetSlug),
    inlineSourceMapStripPlugin,
  ];
  if (!settings.hasChromeMcpPackage) {
    plugins.push(privatePackageShimPlugin);
  }
  return plugins;
}

export function createBundlerOptions(settings, overrides = {}) {
  const { entrypoint: requestedEntrypoint, ...bundlerOverrides } = overrides;
  const entrypoint = requestedEntrypoint
    ? path.isAbsolute(requestedEntrypoint)
      ? requestedEntrypoint
      : path.join(rootDir, requestedEntrypoint)
    : path.join(rootDir, 'src', 'entrypoints', 'cli.tsx');

  return {
    entrypoints: [entrypoint],
    root: rootDir,
    target: 'node',
    format: 'esm',
    packages: 'bundle',
    env: 'disable',
    features: settings.buildFeatures,
    plugins: createBuildPlugins(settings),
    loader: {
      '.md': 'text',
      '.txt': 'text',
    },
    define: settings.define,
    ...bundlerOverrides,
  };
}

function logBuildFailure(logs) {
  for (const log of logs) {
    console.error(log);
  }
}

function getBundlePathLeakPrefixes() {
  const prefixes = new Set([`${rootDir}${path.sep}`, `${rootDir}/`]);
  const repoRoot = path.resolve(rootDir, '..');
  if (repoRoot !== path.parse(repoRoot).root) {
    prefixes.add(`${repoRoot}${path.sep}`);
    prefixes.add(`${repoRoot}/`);
  }
  return [...prefixes].sort((left, right) => right.length - left.length);
}

function sanitizeStandaloneBundleSource(contents) {
  let sanitized = contents.replace(INLINE_SOURCE_MAP_TRAILER_RE, '');

  for (const prefix of getBundlePathLeakPrefixes()) {
    const normalizedPrefix = prefix.replace(/\\/g, '/');
    sanitized = sanitized.split(prefix).join(`${SANITIZED_STANDALONE_ROOT}/`);
    if (normalizedPrefix !== prefix) {
      sanitized = sanitized
        .split(normalizedPrefix)
        .join(`${SANITIZED_STANDALONE_ROOT}/`);
    }
  }

  return sanitized;
}

function getSanitizedStandaloneBundleViolations(contents) {
  const violations = [];
  if (contents.includes('sourceMappingURL=data:application/json')) {
    violations.push('inline source map data url');
  }

  for (const prefix of getBundlePathLeakPrefixes()) {
    const normalizedPrefix = prefix.replace(/\\/g, '/');
    if (contents.includes(prefix) || contents.includes(normalizedPrefix)) {
      violations.push(`checkout path prefix: ${normalizedPrefix}`);
    }
  }

  return violations;
}

function normalizeBundlerOutputPath(outputPath) {
  return outputPath.replace(/^\.\//, '').replace(/\\/g, '/');
}

function getBundlerOutputAbsolutePath(tempDir, relativeOutputPath) {
  return path.join(tempDir, ...relativeOutputPath.split('/'));
}

function getAssetImportBindingName(index, relativeOutputPath) {
  const sanitizedStem = path
    .basename(relativeOutputPath)
    .replace(/[^A-Za-z0-9_$]+/g, '_');
  return `__bundledAsset_${index}_${sanitizedStem}`;
}

function rewriteBundledAssetImports({
  jsSource,
  jsRelativeOutputPath,
  assetRelativeOutputPaths,
}) {
  const jsDir = path.posix.dirname(jsRelativeOutputPath);
  const importStatements = [];
  let rewrittenSource = jsSource;

  assetRelativeOutputPaths.forEach((assetRelativeOutputPath, index) => {
    const assetImportPath = path.posix.relative(jsDir, assetRelativeOutputPath);
    const normalizedImportPath = assetImportPath.startsWith('.')
      ? assetImportPath
      : `./${assetImportPath}`;
    const quotedSpecifier = JSON.stringify(normalizedImportPath);

    if (!rewrittenSource.includes(quotedSpecifier)) {
      return;
    }

    const bindingName = getAssetImportBindingName(index, assetRelativeOutputPath);
    importStatements.push(
      `import ${bindingName} from ${JSON.stringify(normalizedImportPath)} with { type: 'file' };`,
    );
    rewrittenSource = rewrittenSource.split(quotedSpecifier).join(bindingName);
  });

  if (importStatements.length === 0) {
    return jsSource;
  }

  return `${importStatements.join('\n')}\n${rewrittenSource}`;
}

async function buildSanitizedStandaloneBundle({
  settings,
  entrypoint,
  minify,
}) {
  const standaloneTempRoot = path.join(rootDir, '.tmp');
  await mkdir(standaloneTempRoot, { recursive: true });
  const tempDir = await mkdtemp(
    path.join(standaloneTempRoot, 'standalone-build-'),
  );

  try {
    const result = await Bun.build(
      createBundlerOptions(settings, {
        entrypoint,
        minify,
        sourcemap: 'none',
      }),
    );

    if (!result.success) {
      logBuildFailure(result.logs);
      throw new Error('Standalone bundle build failed');
    }

    const normalizedOutputs = result.outputs.map(output => ({
      output,
      relativePath: normalizeBundlerOutputPath(output.path),
    }));
    const bundledSourceOutput = normalizedOutputs.find(({ relativePath }) =>
      relativePath.endsWith('.js'),
    );
    if (!bundledSourceOutput) {
      throw new Error('Standalone bundle build did not emit a JavaScript output');
    }
    const assetOutputs = normalizedOutputs.filter(
      ({ relativePath }) => relativePath !== bundledSourceOutput.relativePath,
    );

    for (const assetOutput of assetOutputs) {
      const absolutePath = getBundlerOutputAbsolutePath(
        tempDir,
        assetOutput.relativePath,
      );
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(
        absolutePath,
        Buffer.from(await assetOutput.output.arrayBuffer()),
      );
    }

    const bundledSource = await bundledSourceOutput.output.text();
    const sourceWithAssetImports = rewriteBundledAssetImports({
      jsSource: bundledSource,
      jsRelativeOutputPath: bundledSourceOutput.relativePath,
      assetRelativeOutputPaths: assetOutputs.map(
        ({ relativePath }) => relativePath,
      ),
    });
    const sanitizedSource = sanitizeStandaloneBundleSource(sourceWithAssetImports);
    const sanitizedViolations =
      getSanitizedStandaloneBundleViolations(sanitizedSource);
    if (sanitizedViolations.length > 0) {
      throw new Error(
        `Sanitized standalone bundle still leaked forbidden content: ${sanitizedViolations.join(', ')}`,
      );
    }
    const sanitizedSourcePath = getBundlerOutputAbsolutePath(
      tempDir,
      bundledSourceOutput.relativePath,
    );
    await mkdir(path.dirname(sanitizedSourcePath), { recursive: true });
    await writeFile(sanitizedSourcePath, sanitizedSource, 'utf8');

    return {
      tempDir,
      sanitizedSourcePath,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function ensureNativeMarkdownRenderer() {
  const nativeRendererBuild = await buildNativeMarkdownRenderer(rootDir);
  if (nativeRendererBuild.built) {
    console.log(
      `[native] built ${path.relative(rootDir, nativeRendererBuild.destinationPath)}`,
    );
  } else {
    console.warn(
      `[native] ${nativeRendererBuild.reason}; continuing with JS fallback`,
    );
  }
  return nativeRendererBuild;
}

async function ensureNativeOpenAICompatWsV2() {
  const wsV2Build = await buildNativeOpenAICompatWsV2(rootDir);
  if (wsV2Build.built) {
    console.log(
      `[native] built ${path.relative(rootDir, wsV2Build.destinationPath)}`,
    );
  } else {
    console.warn(
      `[native] ${wsV2Build.reason}; continuing with SSE fallback for OpenAI compat WS v2`,
    );
  }
  return wsV2Build;
}

export async function buildDistribution(options = {}) {
  const settings = await resolveBuildSettings(options);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const nativeRendererBuild = await ensureNativeMarkdownRenderer();
  const wsV2NativeBuild = await ensureNativeOpenAICompatWsV2();
  const result = await Bun.build(
    createBundlerOptions(settings, {
      outdir: outDir,
      // Shipping builds must not emit source maps. They expose source layout
      // and make accidental disclosure much easier.
      sourcemap: 'none',
    }),
  );

  if (!result.success) {
    logBuildFailure(result.logs);
    throw new Error('Distribution build failed');
  }

  if (existsSync(bundledEntryFile)) {
    await rename(bundledEntryFile, outFile);
    await rm(bundledEntryMapFile, { force: true });
    await rm(path.join(outDir, 'src'), { recursive: true, force: true });
  }
  await rm(outMapFile, { force: true });

  for (const { source, destination } of vendorSources) {
    if (!existsSync(source)) {
      continue;
    }
    await cp(source, destination, { recursive: true, force: true });
  }

  console.log(`Built ${path.relative(rootDir, outFile)}`);
  return {
    outFile,
    nativeRendererBuild,
    wsV2NativeBuild,
    settings,
  };
}

export async function buildStandaloneExecutable(options = {}) {
  const settings = await resolveBuildSettings(options);
  const outfile = options.outfile
    ? path.resolve(options.outfile)
    : path.join(rootDir, '.tmp', 'ncode');
  const compileTarget = options.target;
  const nativeRendererBuild = await ensureNativeMarkdownRenderer();
  const wsV2NativeBuild = await ensureNativeOpenAICompatWsV2();
  const compile = compileTarget
    ? { outfile, target: compileTarget }
    : { outfile };
  const stageOneBundle = await buildSanitizedStandaloneBundle({
    settings,
    entrypoint: options.entrypoint,
    // Local standalone builds are the direct developer usability path.
    // Keep them correctness-first and disable minification by default.
    // The explicit packaging flow opts back into the known-safe minify
    // profile separately.
    minify: options.minify ?? false,
  });

  try {
    const result = await Bun.build({
      entrypoints: [stageOneBundle.sanitizedSourcePath],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      env: 'disable',
      compile,
      minify: false,
      sourcemap: 'none',
    });

    if (!result.success) {
      logBuildFailure(result.logs);
      throw new Error('Standalone compile failed');
    }
  } finally {
    await rm(stageOneBundle.tempDir, { recursive: true, force: true });
  }

  return {
    outfile,
    compileTarget: compile.target ?? null,
    nativeRendererBuild,
    wsV2NativeBuild,
    settings,
  };
}

if (import.meta.main) {
  await buildDistribution();
}
