const sharpLinuxX64Assets = require('../assets/sharpLinuxX64.ts').default;
const sharpLinuxMuslX64Assets = require('../assets/sharpLinuxMuslX64.ts').default;
const loadEmbeddedSharp = require('./loadEmbeddedSharp.cjs');

function isMuslHost() {
  const report = process.report?.getReport?.();
  const glibcVersionRuntime = report?.header?.glibcVersionRuntime;
  return process.platform === 'linux' && !glibcVersionRuntime;
}

function resolveRuntimeAssets() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    return null;
  }
  return isMuslHost() ? sharpLinuxMuslX64Assets : sharpLinuxX64Assets;
}

let cachedBinding;

function loadBinding() {
  if (cachedBinding !== undefined) {
    return cachedBinding;
  }

  const runtimeAssets = resolveRuntimeAssets();
  if (!runtimeAssets) {
    throw new Error(
      `sharp native runtime in this build targets linux-x64 and linux-x64-musl; received ${process.platform}-${process.arch}`,
    );
  }

  cachedBinding = loadEmbeddedSharp(runtimeAssets);
  return cachedBinding;
}

module.exports = loadBinding();
