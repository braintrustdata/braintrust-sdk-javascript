/**
 * Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
 * This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2025 Datadog, Inc.
 **/
const assert = require("node:assert");

const runtimePath = process.env.BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME;
assert(runtimePath, "BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME must be set");
const { newGlobalTracingChannel } = require(runtimePath);

function getContext(channelName) {
  const channel = newGlobalTracingChannel(channelName);
  const context = {};
  channel.subscribe({
    start(message) {
      message.context = context;
      context.start = true;
    },
    end(message) {
      message.context.end = message.result ?? true;
    },
    asyncStart(message) {
      message.context.asyncStart = message.result;
    },
    asyncEnd(message) {
      message.context.asyncEnd = message.result;
    },
  });
  return context;
}

module.exports = {
  assert,
  getContext,
  getTracingHook: newGlobalTracingChannel,
};
