const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'state-refresh.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('exports', 'module', compiled)(moduleUnderTest.exports, moduleUnderTest);
const { createStateRefreshController } = moduleUnderTest.exports;

async function main() {
  let pushed;
  let resolveInitial;
  let unsubscribed = false;
  const applied = [];
  const order = [];
  const controller = createStateRefreshController({
    getState: () => {
      order.push('read');
      return new Promise((resolve) => { resolveInitial = resolve; });
    },
    subscribe: (callback) => {
      order.push('subscribe');
      pushed = callback;
      return () => { unsubscribed = true; };
    },
    applyState: (state) => applied.push(state),
  });

  const initialRead = controller.refresh();
  assert.deepEqual(order, ['subscribe', 'read']);
  pushed({ value: 'new push' });
  resolveInitial({ value: 'stale read' });
  await initialRead;
  assert.deepEqual(applied, [{ value: 'new push' }]);

  controller.dispose();
  assert.equal(unsubscribed, true);
  console.log('State refresh race test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
