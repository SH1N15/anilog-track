const fs = require('node:fs/promises');
const path = require('node:path');

const LEGACY_CACHE_DIRECTORIES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
];

function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

async function directorySize(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  const sizes = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return directorySize(target);
    if (!entry.isFile()) return 0;
    try {
      return (await fs.stat(target)).size;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

function createCacheStorage({ electronSession, userDataDirectory, sessionDataDirectory }) {
  const hasSeparateSessionDirectory = !samePath(userDataDirectory, sessionDataDirectory);
  const legacyDirectories = hasSeparateSessionDirectory
    ? LEGACY_CACHE_DIRECTORIES.map((name) => path.join(userDataDirectory, name))
    : [];

  async function getInfo() {
    const [sessionBytes, legacySizes] = await Promise.all([
      electronSession.getCacheSize(),
      Promise.all(legacyDirectories.map(directorySize)),
    ]);
    const legacyBytes = legacySizes.reduce((total, size) => total + size, 0);
    return {
      bytes: sessionBytes + legacyBytes,
      sessionBytes,
      legacyBytes,
      supported: true,
    };
  }

  async function clear() {
    await Promise.all([
      electronSession.clearCache(),
      typeof electronSession.clearCodeCaches === 'function'
        ? electronSession.clearCodeCaches({})
        : Promise.resolve(),
    ]);
    await Promise.all(legacyDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    return getInfo();
  }

  return { clear, getInfo };
}

module.exports = {
  LEGACY_CACHE_DIRECTORIES,
  createCacheStorage,
  directorySize,
  samePath,
};
