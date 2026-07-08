import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
  [
    "hook-target",
    "cjs-hook-target",
    "cjs-reexport-target",
    "same-source-target",
    "circular-star-target",
    "fs",
    fileURLToPath(new URL("./typescript-hook.mts", import.meta.url)),
    fileURLToPath(new URL("./typescript-cjs-hook.cts", import.meta.url)),
  ],
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
    if (name === "same-source-target") {
      assert.equal(exports.val, 1);
    }
    if (name === "circular-star-target") {
      exports.fromA += 10;
      exports.fromB += 10;
    }
    if (typeof name === "string" && name.endsWith("typescript-hook.mts")) {
      assert.deepEqual(Object.keys(exports).sort(), [
        "Delta",
        "alpha",
        "beta",
        "gamma",
      ]);
    }
    if (typeof name === "string" && name.endsWith("typescript-cjs-hook.cts")) {
      assert.deepEqual(Object.keys(exports).sort(), [
        "default",
        "epsilon",
        "module.exports",
        "zeta",
      ]);
    }
  },
);

const target = await import("hook-target");
const other = await import("unhooked-target");
const cjsTarget = await import("cjs-hook-target");
const cjsReexportTarget = await import("cjs-reexport-target");
const circularStarTarget = await import("circular-star-target");
const sameSourceTarget = await import("same-source-target");
const queryParamTarget = await import("./query-param-target.mjs?iitm=true");
const typescriptTarget = await import("./typescript-hook.mts");
const typescriptCjsTarget = await import("./typescript-cjs-hook.cts");
const fs = await import("node:fs");

assert.equal(target.foo, 57);
assert.equal(target.default(), "patched");
assert.equal(other.foo, 10);
assert.equal(other.default(), "untouched");
assert.equal(cjsTarget.default.value, 8);
assert.equal(cjsReexportTarget.nestedValue, "nested");
assert.equal(cjsReexportTarget.rootValue, undefined);
assert.equal(circularStarTarget.fromA, 11);
assert.equal(circularStarTarget.fromB, 12);
assert.equal(sameSourceTarget.val, 1);
assert.equal(queryParamTarget.sawIitmParam, true);
assert.equal(typescriptTarget.alpha, 1);
assert.equal(typescriptTarget.beta, "two");
assert.equal(typescriptTarget.gamma(1), 2);
assert.equal(new typescriptTarget.Delta().value, 3);
assert.equal(typescriptCjsTarget.default.epsilon, 5);
assert.equal(typescriptCjsTarget.default.zeta({ kind: "square" }), "square");
assert.equal(fs.existsSync("/definitely/not/a/real/path"), true);

const require = createRequire(import.meta.url);
const requiredFs = require("fs");
assert.equal(Object.isExtensible(requiredFs), true);

assert.equal(calls, 8);
hook.unhook();
