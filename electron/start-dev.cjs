const { spawn } = require('node:child_process');
const electron = require('electron');

const url = 'http://127.0.0.1:5173';

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Vite 开发服务器启动超时');
}

waitForServer()
  .then(() => {
    const child = spawn(electron, ['.'], {
      cwd: process.cwd(),
      env: { ...process.env, VITE_DEV_SERVER_URL: url },
      stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
