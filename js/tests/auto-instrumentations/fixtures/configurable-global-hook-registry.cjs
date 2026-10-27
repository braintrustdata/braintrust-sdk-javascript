const { parentPort } = require("node:worker_threads");

const registryKey = "__braintrust_invocation_hooks_v2";
const registryBrand = Symbol.for(
  "braintrust.global-instrumentation-hooks.registry",
);
const foreignRegistry = new Map([["foreign", "entry"]]);
globalThis[registryKey] = foreignRegistry;

const { newGlobalInvocationHook } = require(
  process.env.BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME,
);

const channel = newGlobalInvocationHook(
  "orchestrion:test:configurable-registry",
);
let subscriberCalls = 0;
channel.intercept((target, receiver, args) => {
  subscriberCalls += 1;
  return Reflect.apply(target, receiver, args);
});
const result = channel.invoke(() => "result", undefined, [], {});
const descriptor = Object.getOwnPropertyDescriptor(globalThis, registryKey);

parentPort?.postMessage({
  type: "configurable-registry",
  result: {
    descriptor: {
      configurable: descriptor?.configurable,
      enumerable: descriptor?.enumerable,
      writable: descriptor?.writable,
    },
    foreignRegistryBranded: foreignRegistry[registryBrand] !== undefined,
    foreignRegistryRetained: descriptor?.value === foreignRegistry,
    result,
    subscriberCalls,
  },
});
