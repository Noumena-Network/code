const sharpDarwinArm64Assets = require('../assets/sharpDarwinArm64.ts').default;
const loadEmbeddedSharp = require('./loadEmbeddedSharp.cjs');

let cachedBinding;

function loadBinding() {
  if (cachedBinding !== undefined) {
    return cachedBinding;
  }

  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(
      `sharp native runtime in this build targets darwin-arm64; received ${process.platform}-${process.arch}`,
    );
  }

  cachedBinding = loadEmbeddedSharp(sharpDarwinArm64Assets);
  return cachedBinding;
}

module.exports = loadBinding();
