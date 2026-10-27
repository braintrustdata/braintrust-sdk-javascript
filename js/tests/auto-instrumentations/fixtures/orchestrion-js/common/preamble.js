/**
 * Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
 * This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2025 Datadog, Inc.
 **/
const assert = require("node:assert");

const runtimePath = process.env.BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME;
assert(runtimePath, "BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME must be set");
const { newGlobalInvocationHook } = require(runtimePath);

function getContext(channelName) {
  const context = {};
  newGlobalInvocationHook(channelName).intercept((target, receiver, args) => {
    context.called = true;
    const callbackIndex = args.findLastIndex(
      (arg) => typeof arg === "function",
    );
    if (callbackIndex !== -1) {
      const callback = args[callbackIndex];
      args[callbackIndex] = function (...callbackArgs) {
        context.result = callbackArgs[1];
        return Reflect.apply(callback, this, callbackArgs);
      };
    }
    const result = Reflect.apply(target, receiver, args);
    if (result && typeof result.then === "function") {
      result.then((value) => {
        context.result = value;
      });
    } else if (callbackIndex === -1) {
      context.result = result;
    }
    return result;
  });
  return context;
}

module.exports = {
  assert,
  getContext,
  getInvocationHook: newGlobalInvocationHook,
};
