const { parentPort } = require("node:worker_threads");

const registryKey = "__braintrust_instrumentation_hooks";
const registryBrand = Symbol.for(
  "braintrust.global-instrumentation-hooks.registry",
);
const foreignRegistry = new Map([["foreign", "entry"]]);
globalThis[registryKey] = foreignRegistry;

const { newGlobalTracingChannel } = require(
  process.env.BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME,
);

const channel = newGlobalTracingChannel(
  "orchestrion:test:configurable-registry",
);
let subscriberCalls = 0;
channel.subscribe({
  start() {
    subscriberCalls += 1;
  },
});
const result = channel.traceSync(() => "result");
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
