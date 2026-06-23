import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_FORBIDDEN_KEYS = [
  'packageDir',
  'binaryPath',
  'manifestPath',
  'zipPath',
];

const STATIC_FORBIDDEN_SUBSTRINGS = [
  {
    label: 'repo checkout path',
    value: '/mlstore/src/noumena/',
  },
  {
    label: 'windows repo checkout path',
    value: '\\mlstore\\src\\noumena\\',
  },
  {
    label: 'pkcs8 private key marker',
    value: '-----BEGIN PRIVATE KEY-----',
  },
  {
    label: 'rsa private key marker',
    value: '-----BEGIN RSA PRIVATE KEY-----',
  },
  {
    label: 'ec private key marker',
    value: '-----BEGIN EC PRIVATE KEY-----',
  },
  {
    label: 'openssh private key marker',
    value: '-----BEGIN OPENSSH PRIVATE KEY-----',
  },
];

const ENV_DERIVED_FORBIDDEN_VALUE_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOUMENA_API_KEY',
  'OPENAI_API_KEY',
];

// Production defaults that are intentionally baked into the binary via
// src/constants/oauth.ts and other source-controlled files. The audit must
// not treat these as leaks just because they are also present in the build
// environment.
const ALLOWED_ENV_DERIVED_VALUES = new Set([
  'https://api.noumena.com',
  'https://console.noumena.com',
  'Kimi 2.7 Coder',
]);


function normalizeForbiddenPathValue(value) {
  const normalized = path.resolve(value);
  return normalized.length >= 8 ? normalized : null;
}

function collectLocalPathForbiddenSubstrings() {
  const candidates = [
    { label: 'current checkout path', value: process.cwd() },
    { label: 'github workspace path', value: process.env.GITHUB_WORKSPACE },
  ];
  const seen = new Set();
  const patterns = [];

  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const normalized = normalizeForbiddenPathValue(candidate.value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    patterns.push({ label: candidate.label, value: normalized });

    const windowsValue = normalized.replaceAll('/', '\\');
    if (windowsValue !== normalized && !seen.has(windowsValue)) {
      seen.add(windowsValue);
      patterns.push({
        label: `${candidate.label} (windows separators)`,
        value: windowsValue,
      });
    }
  }

  return patterns;
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

function collectEnvDerivedForbiddenSubstrings() {
  const patterns = [];
  for (const envName of ENV_DERIVED_FORBIDDEN_VALUE_VARS) {
    const value = process.env[envName]?.trim();
    if (!value || value.length < 8 || ALLOWED_ENV_DERIVED_VALUES.has(value)) {
      continue;
    }
    patterns.push({
      label: `env ${envName}`,
      value,
    });
  }
  return patterns;
}

function collectManifestAbsolutePaths(value, currentPath = '$', matches = []) {
  if (typeof value === 'string') {
    const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(value);
    if (path.isAbsolute(value) || isWindowsAbsolute) {
      matches.push({
        path: currentPath,
        value,
      });
    }
    return matches;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectManifestAbsolutePaths(entry, `${currentPath}[${index}]`, matches);
    });
    return matches;
  }

  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      collectManifestAbsolutePaths(entry, `${currentPath}.${key}`, matches);
    }
  }

  return matches;
}

function findForbiddenSubstringMatches(haystack, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    if (haystack.includes(pattern.value)) {
      matches.push(pattern.label);
    }
  }
  return matches;
}

async function collectBinaryStrings(binaryPath) {
  const proc = Bun.spawn({
    cmd: ['strings', '-a', binaryPath],
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
      `Failed to extract binary strings from ${binaryPath}: ${stderr || `exit ${exitCode}`}`,
    );
  }

  return stdout;
}

export async function auditCompiledPackage({
  packageDir,
  binaryPath,
  manifestPath,
}) {
  const files = await walkFiles(packageDir);
  const mapFiles = files
    .filter(file => file.relativePath.endsWith('.map'))
    .map(file => file.relativePath);

  if (mapFiles.length > 0) {
    throw new Error(
      `Compiled package contained source maps: ${mapFiles.join(', ')}`,
    );
  }

  const manifestText = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const manifestForbiddenKeys = MANIFEST_FORBIDDEN_KEYS.filter(key =>
    Object.prototype.hasOwnProperty.call(manifest, key),
  );
  if (manifestForbiddenKeys.length > 0) {
    throw new Error(
      `Shipped manifest leaked local path keys: ${manifestForbiddenKeys.join(', ')}`,
    );
  }

  const manifestAbsolutePaths = collectManifestAbsolutePaths(manifest);
  if (manifestAbsolutePaths.length > 0) {
    throw new Error(
      `Shipped manifest leaked absolute paths: ${manifestAbsolutePaths
        .map(match => `${match.path}=${match.value}`)
        .join(', ')}`,
    );
  }

  const forbiddenSubstrings = [
    ...STATIC_FORBIDDEN_SUBSTRINGS,
    ...collectLocalPathForbiddenSubstrings(),
    ...collectEnvDerivedForbiddenSubstrings(),
  ];

  const manifestLeaks = findForbiddenSubstringMatches(
    manifestText,
    forbiddenSubstrings,
  );
  if (manifestLeaks.length > 0) {
    throw new Error(
      `Shipped manifest contained forbidden substrings: ${manifestLeaks.join(', ')}`,
    );
  }

  const binaryStrings = await collectBinaryStrings(binaryPath);
  const binaryLeaks = findForbiddenSubstringMatches(
    binaryStrings,
    forbiddenSubstrings,
  );
  if (binaryLeaks.length > 0) {
    throw new Error(
      `Compiled binary contained forbidden substrings: ${binaryLeaks.join(', ')}`,
    );
  }

  return {
    ok: true,
    fileCount: files.length,
    forbiddenPatternsChecked: forbiddenSubstrings.map(pattern => pattern.label),
  };
}
