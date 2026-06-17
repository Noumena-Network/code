import addonPath from '../../../node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node' with { type: 'file' }
import libvipsPath from '../../../node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.17.3.dylib' with { type: 'file' }

const sharpDarwinX64Assets = {
  slug: 'darwin-x64',
  addonPath,
  addonRelativePath: 'node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node',
  libvipsPath,
  libvipsRelativePath:
    'node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.17.3.dylib',
}

export default sharpDarwinX64Assets
