const { materializeEmbeddedAssetGroup } = require('../nativeAssetRuntime.ts');

// Materializes an embedded sharp asset group (native addon + bundled libvips)
// to a temp directory whose layout preserves the `node_modules/@img/...`
// structure. That structure matters: the platform addon resolves its libvips
// dependency through a relative rpath ($ORIGIN / @loader_path) that only lines
// up when the two files keep their original relative positions.
function loadEmbeddedSharp(runtimeAssets) {
  const materialized = materializeEmbeddedAssetGroup(
    `sharp-${runtimeAssets.slug}`,
    [
      {
        embeddedPath: runtimeAssets.addonPath,
        relativePath: runtimeAssets.addonRelativePath,
      },
      {
        embeddedPath: runtimeAssets.libvipsPath,
        relativePath: runtimeAssets.libvipsRelativePath,
      },
    ],
  );

  return require(materialized.paths[runtimeAssets.addonRelativePath]);
}

module.exports = loadEmbeddedSharp;
