const sharpDarwinX64Assets = require('../assets/sharpDarwinX64.ts').default;
const loadEmbeddedSharp = require('./loadEmbeddedSharp.cjs');

let cachedBinding;

function loadBinding() {
  if (cachedBinding !== undefined) {
    return cachedBinding;
  }

  if (process.platform !== 'darwin' || process.arch !== 'x64') {
    throw new Error(
      `sharp native runtime in this build targets darwin-x64; received ${process.platform}-${process.arch}`,
    );
  }

  cachedBinding = loadEmbeddedSharp(sharpDarwinX64Assets);
  return cachedBinding;
}

module.exports = loadBinding();
