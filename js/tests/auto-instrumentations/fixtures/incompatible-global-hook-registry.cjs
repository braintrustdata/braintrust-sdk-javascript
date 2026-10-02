const { parentPort } = require("node:worker_threads");

Object.defineProperty(globalThis, "__braintrust_invocation_hooks_v2", {
  configurable: false,
  enumerable: false,
  value: {},
  writable: false,
});

const { newGlobalInvocationHook } = require(
  process.env.BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME,
);

const channel = newGlobalInvocationHook(
  "orchestrion:test:incompatible-registry",
);
let subscriberCalls = 0;
let providerCalls = 0;
channel.intercept((target, receiver, args) => {
  subscriberCalls += 1;
  return Reflect.apply(target, receiver, args);
});
const result = channel.invoke(
  () => {
    providerCalls += 1;
    return "result";
  },
  undefined,
  [],
  {},
);

parentPort?.postMessage({
  type: "incompatible-registry",
  result: {
    hasInterceptors: channel.hasInterceptors,
    providerCalls,
    result,
    subscriberCalls,
  },
});
