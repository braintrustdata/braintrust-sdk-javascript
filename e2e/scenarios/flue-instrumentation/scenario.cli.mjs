const { runCliFlueInstrumentation, runMain } =
  await import("./scenario.impl.mjs");

runMain(runCliFlueInstrumentation);
