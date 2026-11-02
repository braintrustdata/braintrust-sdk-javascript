import {
  runTests,
  testMustacheTemplate,
  testNunjucksTemplate,
} from "../../../../../../js/smoke/shared/dist/index.js";
import * as braintrust from "braintrust";
import { nunjucksPlugin } from "@braintrust/templates-nunjucks-js";

async function main() {
  // Register nunjucks plugin before running tests
  braintrust.registerTemplatePlugin(nunjucksPlugin);

  const { failed } = await runTests({
    name: "templates-nunjucks-basic-render",
    braintrust,
    tests: [testMustacheTemplate, testNunjucksTemplate],
    skipCoverage: true,
  });

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
