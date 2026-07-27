const { spawnSync } = require('node:child_process');
const path = require('node:path');

const target = process.argv[2] || 'standard';
const edition = target === 'original' || target === 'android-original' ? 'original' : 'standard';
const isAndroid = target === 'android' || target === 'android-original';
const environment = {
  ...process.env,
  ANILOG_EDITION: edition,
  VITE_ANILOG_EDITION: edition,
  VITE_ANILOG_PLATFORM: isAndroid ? 'android' : 'desktop',
};

function run(modulePath, args) {
  const result = spawnSync(process.execPath, [require.resolve(modulePath), ...args], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run('typescript/bin/tsc', ['-b']);
run(path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'), ['build']);
