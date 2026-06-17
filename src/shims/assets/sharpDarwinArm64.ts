import addonPath from '../../../node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node' with { type: 'file' }
import libvipsPath from '../../../node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib' with { type: 'file' }

const sharpDarwinArm64Assets = {
  slug: 'darwin-arm64',
  addonPath,
  addonRelativePath: 'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
  libvipsPath,
  libvipsRelativePath:
    'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib',
}

export default sharpDarwinArm64Assets
