import * as braintrust from "braintrust";
import {
  runTests,
  expectFailure,
  testBasicSpanLogging,
  testMultipleSpans,
  testDirectLogging,
  testJSONAttachment,
  testAsyncLocalStorageTraced,
  testNestedTraced,
  testCurrentSpan,
  testCoreLoggingExports,
  testDatasetExports,
  testPromptExports,
  testExperimentExports,
  testEvalExports,
  testTracingExports,
  testClientWrapperExports,
  testUtilityExports,
  testFunctionExports,
  testFramework2Exports,
  testIDGeneratorExports,
  testTestingExports,
  testStateManagementExports,
  testBuildResolution,
  testMustacheTemplate,
  testNunjucksTemplate,
  testEvalSmoke,
} from "../../../shared";
import { createBrowserHarness, type BrowserSmokeResults } from "./harness";

declare global {
  interface Window {
    __btBrowserSmokeResults?: BrowserSmokeResults;
  }
}

const output = document.getElementById("output");
if (!output) {
  throw new Error("Missing #output element");
}

const harness = createBrowserHarness(output);
window.__btBrowserSmokeResults = harness.results;

async function runAllTestSuites() {
  harness.log("=== Running test suites ===");

  const { passed, failed, xfail } = await runTests({
    name: "playwright-browser",
    braintrust,
    tests: [
      testCoreLoggingExports,
      testDatasetExports,
      testPromptExports,
      testExperimentExports,
      testEvalExports,
      testTracingExports,
      testClientWrapperExports,
      testUtilityExports,
      testFunctionExports,
      testFramework2Exports,
      testIDGeneratorExports,
      testTestingExports,
      testStateManagementExports,
      testBuildResolution("browser"),
      testBasicSpanLogging,
      testMultipleSpans,
      testDirectLogging,
      testJSONAttachment,
      expectFailure(
        testAsyncLocalStorageTraced,
        (e: { message: string }) => e.message.includes("span_parents"),
        "No AsyncLocalStorage available",
      ),
      expectFailure(
        testNestedTraced,
        (e: { message: string }) => e.message.includes("span_parents"),
        "No AsyncLocalStorage available",
      ),
      testCurrentSpan,
      testEvalSmoke,
      testMustacheTemplate,
      expectFailure(
        testNunjucksTemplate,
        (e: { message: string }) =>
          e.message.includes("requires @braintrust/template-nunjucks"),
        "Nunjucks requires separate package",
      ),
    ],
  });

  for (const r of passed) {
    harness.pass("tests", r.name, r.message);
  }
  for (const r of xfail) {
    harness.pass("tests", r.name, `[xfail] ${r.message}`);
  }
  for (const r of failed) {
    harness.fail(
      "tests",
      r.name,
      r.error || new Error("Test failed"),
      r.message,
    );
  }

  harness.completeSection("tests");
}

async function main() {
  const timeoutMs = 55_000;
  const timeout = window.setTimeout(() => {
    if (!harness.results.completed) {
      harness.fail(
        "runtime",
        "timeout",
        new Error("Timed out waiting for browser tests to finish"),
      );
      harness.completeAll();
    }
  }, timeoutMs);

  await runAllTestSuites();
  window.clearTimeout(timeout);
  harness.log("\n=== All browser suites complete ===");
  harness.completeAll();
}

void main();
