async function main() {
  require("braintrust/apply-instrumentation");
  await import("./test-app-esm.mjs");
}

main();
