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

let calls = 0;
const hook = new Hook(["virtual-reload-source-per-load"], (exports) => {
  calls++;
  globalThis.__braintrustIitmReloadHookValue = exports.value;
});

await waitForAllMessagesAcknowledged();

process.on("exit", () => {
  assert.equal(calls, 1);
  hook.unhook();
  addHookMessagePort.close();
});
