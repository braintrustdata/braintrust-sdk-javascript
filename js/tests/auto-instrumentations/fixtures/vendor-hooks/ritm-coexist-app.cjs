const assert = require("node:assert");
const Module = require("node:module");
const {
  default: Hook,
} = require("../../../../src/auto-instrumentations/loader/module-hooks/ritm.ts");

const originalRequire = Module.prototype.require;

function clearTarget() {
  delete require.cache[require.resolve("ritm-target")];
}

function wrapRequire(previousRequire) {
  return function foreignRequire(id) {
    const exports = previousRequire.call(this, id);
    if (id === "ritm-target") {
      return { ...exports, value: exports.value + 100 };
    }
    return exports;
  };
}

try {
  Module.prototype.require = wrapRequire(originalRequire);
  const hookAfterForeign = new Hook(["ritm-target"], (exports) => {
    return { ...exports, value: exports.value + 10 };
  });

  assert.equal(require("ritm-target").value, 111);
  hookAfterForeign.unhook();
  clearTarget();
  assert.equal(require("ritm-target").value, 101);
} finally {
  Module.prototype.require = originalRequire;
  clearTarget();
}

try {
  const hookBeforeForeign = new Hook(["ritm-target"], (exports) => {
    return { ...exports, value: exports.value + 10 };
  });
  Module.prototype.require = wrapRequire(Module.prototype.require);

  clearTarget();
  assert.equal(require("ritm-target").value, 111);
  hookBeforeForeign.unhook();
  clearTarget();
  assert.equal(require("ritm-target").value, 101);
} finally {
  Module.prototype.require = originalRequire;
  clearTarget();
}
