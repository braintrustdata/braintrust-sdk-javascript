import assert from "node:assert";
import { createRequire } from "node:module";
import { Hook } from "../../../../src/auto-instrumentations/import-in-the-middle/index.mts";
import {
  register,
  supportsSyncHooks,
} from "../../../../src/auto-instrumentations/import-in-the-middle/register-hooks.mts";

if (!supportsSyncHooks()) {
  process.exit(0);
}

register();

let calls = 0;
const hook = new Hook(
  ["hook-target", "cjs-hook-target", "fs"],
  (exports, name) => {
    calls++;
    if (name === "hook-target") {
      exports.foo += 15;
      exports.default = () => "patched";
    }
    if (name === "cjs-hook-target") {
      exports.default.value = 8;
    }
    if (name === "fs") {
      exports.existsSync = () => true;
    }
  },
);

const target = await import("hook-target");
const other = await import("unhooked-target");
const cjsTarget = await import("cjs-hook-target");
const fs = await import("node:fs");

assert.equal(target.foo, 57);
assert.equal(target.default(), "patched");
assert.equal(other.foo, 10);
assert.equal(other.default(), "untouched");
assert.equal(cjsTarget.default.value, 8);
assert.equal(fs.existsSync("/definitely/not/a/real/path"), true);

const require = createRequire(import.meta.url);
const requiredFs = require("fs");
assert.equal(Object.isExtensible(requiredFs), true);

assert.equal(calls, 3);
hook.unhook();
