const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowLifecycle, isHiddenLaunch } = require('../electron/window-lifecycle.cjs');

assert.equal(isHiddenLaunch(['AniLog.exe']), false);
assert.equal(isHiddenLaunch(['AniLog.exe', '--hidden']), true);
assert.equal(isHiddenLaunch(['AniLog.exe', '--background']), true);

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.minimized = false;
    this.shown = 0;
    this.focused = 0;
    this.restored = 0;
  }

  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }

  focus() { this.focused += 1; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; this.restored += 1; }
  show() { this.shown += 1; }
}

function cancelableEvent() {
  return {
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

let keepInTray = true;
let quitting = false;
const windows = [];
const lifecycle = createWindowLifecycle({
  createWindow: () => {
    const window = new FakeWindow();
    windows.push(window);
    return window;
  },
  shouldKeepInTray: () => keepInTray,
  isQuitting: () => quitting,
});

const first = lifecycle.show();
assert.equal(windows.length, 1);
assert.equal(first.shown, 0);
lifecycle.show();
assert.equal(windows.length, 1);
first.emit('ready-to-show');
assert.equal(first.shown, 1);
assert.equal(first.focused, 1);

first.minimized = true;
lifecycle.show();
assert.equal(first.restored, 1);
assert.equal(first.shown, 2);

const minimizeEvent = cancelableEvent();
first.emit('minimize', minimizeEvent);
assert.equal(minimizeEvent.prevented, true);
assert.equal(first.destroyed, true);
assert.equal(lifecycle.getWindow(), null);

const second = lifecycle.show();
assert.equal(windows.length, 2);
second.emit('ready-to-show');
assert.equal(second.shown, 1);

const closeEvent = cancelableEvent();
second.emit('close', closeEvent);
assert.equal(closeEvent.prevented, true);
assert.equal(second.destroyed, true);

keepInTray = false;
const third = lifecycle.show();
third.emit('ready-to-show');
const normalCloseEvent = cancelableEvent();
third.emit('close', normalCloseEvent);
assert.equal(normalCloseEvent.prevented, false);
assert.equal(third.destroyed, false);
third.emit('closed');
assert.equal(lifecycle.getWindow(), null);

keepInTray = true;
const fourth = lifecycle.show();
fourth.emit('ready-to-show');
quitting = true;
const quitCloseEvent = cancelableEvent();
fourth.emit('close', quitCloseEvent);
assert.equal(quitCloseEvent.prevented, false);
assert.equal(fourth.destroyed, false);

console.log('Window lifecycle tests passed.');
