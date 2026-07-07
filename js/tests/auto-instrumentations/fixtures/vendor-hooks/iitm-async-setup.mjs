import assert from "node:assert";
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
  ["hook-target", "cjs-hook-target", "cjs-reexport-target"],
  (exports, name) => {
    globalThis.__braintrustIitmAsyncHookCalls++;
    if (name === "hook-target") {
      exports.foo += 15;
      exports.default = () => "patched";
    }
    if (name === "cjs-hook-target") {
      exports.default.value = 8;
    }
  },
);

await waitForAllMessagesAcknowledged();

process.on("exit", () => {
  assert.equal(globalThis.__braintrustIitmAsyncHookCalls, 3);
  hook.unhook();
  addHookMessagePort.close();
});
