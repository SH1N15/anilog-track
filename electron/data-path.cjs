const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'anilog-state.json';

function validateStateFile(directory) {
  const file = path.join(directory, STATE_FILE);
  if (!fs.existsSync(file)) return;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${STATE_FILE} 不是有效的状态文件`);
  }
}

function ensureWritableDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.anilog-write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok', { flag: 'wx' });
  fs.unlinkSync(probe);
}

function migrateLegacyUserData(legacyDirectory, targetDirectory) {
  const legacy = path.resolve(legacyDirectory);
  const target = path.resolve(targetDirectory);
  if (legacy === target) {
    ensureWritableDirectory(target);
    return { status: 'existing', legacyRemoved: true };
  }

  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    validateStateFile(target);
    ensureWritableDirectory(target);
    return { status: 'existing', legacyRemoved: !fs.existsSync(legacy) };
  }

  if (!fs.existsSync(legacy)) {
    ensureWritableDirectory(target);
    return { status: 'created', legacyRemoved: true };
  }

  validateStateFile(legacy);
  if (fs.existsSync(target)) fs.rmdirSync(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.migrating-${process.pid}`;
  if (fs.existsSync(temporary)) throw new Error(`迁移临时目录已存在：${temporary}`);

  try {
    fs.cpSync(legacy, temporary, { recursive: true, errorOnExist: true });
    validateStateFile(temporary);
    fs.renameSync(temporary, target);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  let legacyRemoved = true;
  try {
    fs.rmSync(legacy, { recursive: true, force: true });
  } catch {
    legacyRemoved = false;
  }
  ensureWritableDirectory(target);
  return { status: 'migrated', legacyRemoved };
}

function configurePackagedDataPaths(electronApp, executablePath = process.execPath) {
  if (!electronApp.isPackaged) {
    return { dataDirectory: electronApp.getPath('userData'), status: 'development', legacyRemoved: true };
  }

  const legacyDirectory = electronApp.getPath('userData');
  const dataDirectory = path.join(path.dirname(executablePath), 'data');
  const migration = migrateLegacyUserData(legacyDirectory, dataDirectory);
  const sessionDirectory = path.join(dataDirectory, 'Session Data');
  const logsDirectory = path.join(dataDirectory, 'logs');
  const crashDirectory = path.join(dataDirectory, 'Crashpad');
  [sessionDirectory, logsDirectory, crashDirectory].forEach(ensureWritableDirectory);

  electronApp.setPath('userData', dataDirectory);
  electronApp.setPath('sessionData', sessionDirectory);
  electronApp.setPath('crashDumps', crashDirectory);
  electronApp.setAppLogsPath(logsDirectory);

  return { dataDirectory, ...migration };
}

module.exports = {
  configurePackagedDataPaths,
  ensureWritableDirectory,
  migrateLegacyUserData,
  validateStateFile,
};
