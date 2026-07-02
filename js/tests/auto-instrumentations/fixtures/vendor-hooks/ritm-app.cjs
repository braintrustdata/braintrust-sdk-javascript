const assert = require("node:assert");
const {
  Hook,
} = require("../../../../src/auto-instrumentations/require-in-the-middle");

let calls = 0;
const hook = new Hook(["ritm-target"], (exports, name) => {
  calls++;
  assert.equal(name, "ritm-target");
  exports.value += 10;
  return exports;
});

assert.equal(require("ritm-target").value, 11);
assert.equal(require("ritm-target").value, 11);
assert.equal(calls, 1);
assert.equal(require("ritm-other").value, 5);

hook.unhook();
delete require.cache[require.resolve("ritm-target")];
assert.equal(require("ritm-target").value, 1);

let builtinCalls = 0;
const builtinHook = new Hook(["path"], (exports, name) => {
  builtinCalls++;
  assert.equal(name, "path");
  return { ...exports, join: () => "patched" };
});

assert.equal(require("node:path").join("a", "b"), "patched");
assert.equal(require("path").join("a", "b"), "patched");

if (typeof process.getBuiltinModule === "function") {
  assert.equal(process.getBuiltinModule("path").join("a", "b"), "patched");
}

assert.equal(builtinCalls, 1);
builtinHook.unhook();
