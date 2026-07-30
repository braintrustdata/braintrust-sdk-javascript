import { parentPort } from "node:worker_threads";

const imported = await import(process.env.BRAINTRUST_QUERY_HOOK_URL);
const state = globalThis[Symbol.for("braintrust.applyAutoInstrumentation")];

parentPort?.postMessage({
  result: {
    applied: state?.applied === true,
    hasInitialize: typeof imported.initialize === "function",
    hasLoad: typeof imported.load === "function",
    hasRegister: typeof imported.register === "function",
    hasResolve: typeof imported.resolve === "function",
  },
  type: "hook-query-result",
});
