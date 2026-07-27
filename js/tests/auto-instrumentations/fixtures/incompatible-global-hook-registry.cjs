const { parentPort } = require("node:worker_threads");

Object.defineProperty(globalThis, "__braintrust_instrumentation_hooks", {
  configurable: false,
  enumerable: false,
  value: {},
  writable: false,
});

const { newGlobalTracingChannel } = require(
  process.env.BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME,
);

const channel = newGlobalTracingChannel(
  "orchestrion:test:incompatible-registry",
);
let subscriberCalls = 0;
let providerCalls = 0;
channel.subscribe({
  start() {
    subscriberCalls += 1;
  },
});
const result = channel.traceSync(() => {
  providerCalls += 1;
  return "result";
});

parentPort?.postMessage({
  type: "incompatible-registry",
  result: {
    hasSubscribers: channel.hasSubscribers,
    providerCalls,
    result,
    subscriberCalls,
  },
});
