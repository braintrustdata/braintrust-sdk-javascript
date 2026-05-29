import "braintrust";

await new Promise((resolve) => setImmediate(resolve));

const { runAutoFlueInstrumentation, runMain } =
  await import("./scenario.impl.mjs");

runMain(runAutoFlueInstrumentation);
