const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');

module.exports = async function afterPackOriginal(context) {
  const archive = path.join(context.appOutDir, 'resources', 'app.asar');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'anilog-original-asar-'));
  try {
    asar.extractAll(archive, temporary);
    const packagePath = path.join(temporary, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (metadata.dependencies) {
      delete metadata.dependencies['bangumi-data'];
      if (Object.keys(metadata.dependencies).length === 0) delete metadata.dependencies;
    }
    fs.writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
    fs.unlinkSync(archive);
    await asar.createPackage(temporary, archive);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
};
