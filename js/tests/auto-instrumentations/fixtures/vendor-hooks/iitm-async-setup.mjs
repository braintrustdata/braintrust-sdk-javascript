import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import {
  Hook,
  createAddHookMessageChannel,
} from "../../../../src/auto-instrumentations/import-in-the-middle/index.mts";

const hookUrl = new URL(
  "../../../../src/auto-instrumentations/import-in-the-middle/hook.mts",
  import.meta.url,
);
const { addHookMessagePort, registerOptions, waitForAllMessagesAcknowledged } =
  createAddHookMessageChannel();

register(hookUrl, import.meta.url, registerOptions);

globalThis.__braintrustIitmAsyncHookCalls = 0;
const hook = new Hook(
  [
    "hook-target",
    "cjs-hook-target",
    "cjs-reexport-target",
    "same-source-target",
    "circular-star-target",
    fileURLToPath(new URL("./typescript-hook.mts", import.meta.url)),
    fileURLToPath(new URL("./typescript-cjs-hook.cts", import.meta.url)),
  ],
  (exports, name) => {
    globalThis.__braintrustIitmAsyncHookCalls++;
    if (name === "hook-target") {
      exports.foo += 15;
      exports.default = () => "patched";
    }
    if (name === "cjs-hook-target") {
      exports.default.value = 8;
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

await waitForAllMessagesAcknowledged();

process.on("exit", () => {
  assert.equal(globalThis.__braintrustIitmAsyncHookCalls, 7);
  hook.unhook();
  addHookMessagePort.close();
});
