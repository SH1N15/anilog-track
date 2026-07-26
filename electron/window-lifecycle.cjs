function isUsableWindow(window) {
  return Boolean(window && !window.isDestroyed());
}

function createWindowLifecycle({ createWindow, shouldKeepInTray, isQuitting }) {
  let activeWindow = null;
  let ready = false;

  function reveal(window) {
    if (!isUsableWindow(window) || window !== activeWindow) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  function destroyForTray(window = activeWindow) {
    if (!isUsableWindow(window) || window !== activeWindow) return false;

    activeWindow = null;
    ready = false;
    window.destroy();
    return true;
  }

  function attach(window) {
    activeWindow = window;
    ready = false;

    window.once('ready-to-show', () => {
      if (window !== activeWindow || !isUsableWindow(window)) return;
      ready = true;
      reveal(window);
    });

    window.on('minimize', (event) => {
      if (!shouldKeepInTray()) return;
      event.preventDefault();
      destroyForTray(window);
    });

    window.on('close', (event) => {
      if (isQuitting() || !shouldKeepInTray()) return;
      event.preventDefault();
      destroyForTray(window);
    });

    window.on('closed', () => {
      if (window !== activeWindow) return;
      activeWindow = null;
      ready = false;
    });
  }

  function ensureWindow() {
    if (isUsableWindow(activeWindow)) return activeWindow;
    const window = createWindow();
    attach(window);
    return window;
  }

  function show() {
    const window = ensureWindow();
    if (ready) reveal(window);
    return window;
  }

  return {
    destroyForTray,
    getWindow: () => (isUsableWindow(activeWindow) ? activeWindow : null),
    show,
  };
}

module.exports = { createWindowLifecycle, isUsableWindow };
