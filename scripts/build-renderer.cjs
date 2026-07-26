const { spawnSync } = require('node:child_process');
const path = require('node:path');

const edition = process.argv[2] === 'original' ? 'original' : 'standard';
const environment = {
  ...process.env,
  ANILOG_EDITION: edition,
  VITE_ANILOG_EDITION: edition,
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
