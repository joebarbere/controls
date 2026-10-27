// electron-builder configuration. Run from the workspace root:
//   pnpm package:desktop      → installers for the current OS into dist/release/
//   pnpm package:desktop:dir  → unpacked app only (fast smoke tests)
// The app directory is assembled by apps/desktop/build.mjs; it has no node_modules.
const { version: electronVersion } = require('electron/package.json');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.joebarbere.controls',
  productName: 'Controls',
  copyright: 'Copyright © 2026 Joe Barbere',
  electronVersion,
  directories: {
    app: 'dist/apps/desktop',
    output: 'dist/release',
    buildResources: 'apps/desktop/build-resources',
  },
  files: ['**/*', '!**/*.map'],
  asar: true,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // Hardening — verified after packaging with `npx @electron/fuses read --app <binary>`.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  linux: {
    target: ['AppImage', 'deb', 'rpm'],
    category: 'Game',
    synopsis: 'Realistic electrician and controls-engineer simulation',
    executableName: 'controls',
  },
  win: { target: ['nsis'] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  mac: {
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    category: 'public.app-category.simulation-games',
    identity: null, // unsigned until the signing decision (plan §9.3)
  },
  publish: [{ provider: 'github', owner: 'joebarbere', repo: 'controls', releaseType: 'draft' }],
};
