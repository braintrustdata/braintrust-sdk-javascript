async function main() {
  require("braintrust/apply-auto-instrumentation");
  await import("./test-app-esm.mjs");
}

main();
