import { test, expect } from "@playwright/test";
import {
  displayTestResults,
  type TestResult,
} from "../../../shared/dist/index.js";

test.describe("Braintrust SDK Browser Tests", () => {
  test("should run all browser tests (shared + eval + prompt)", async ({
    page,
    baseURL,
  }) => {
    const results: TestResult[] = [];

    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        console.error(`[Browser Console Error] ${text}`);
      }
    });

    page.on("pageerror", (error) => {
      console.error("[Browser Page Error]", error.message);
    });

    page.on("requestfailed", (request) => {
      console.error(
        `[Request Failed] ${request.url()} - ${request.failure()?.errorText}`,
      );
    });

    const response = await page.goto(`${baseURL}/pages/browser-tests.html`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    if (!response || !response.ok()) {
      throw new Error(`Failed to load page: ${response?.status()}`);
    }

    try {
      await page.waitForFunction(
        () => {
          return (window as any).__btBrowserSmokeResults?.completed === true;
        },
        { timeout: 60000 },
      );
    } catch (error) {
      const testState = await page.evaluate(() => {
        return {
          smoke: (window as any).__btBrowserSmokeResults,
          documentReady: document.readyState,
          bodyContent: document.body?.innerText?.substring(0, 500),
        };
      });
      console.error(
        "Test timeout - Current state:",
        JSON.stringify(testState, null, 2),
      );

      await page.screenshot({
        path: "test-timeout-browser.png",
        fullPage: true,
      });
      throw error;
    }

    const smoke = await page.evaluate(
      () => (window as any).__btBrowserSmokeResults,
    );

    // Test 1: Overall completion
    if (smoke && smoke.completed) {
      results.push({
        status: "pass",
        name: "Browser tests completed",
      });
    } else {
      results.push({
        status: "fail",
        name: "Browser tests completed",
        error: { message: "Tests did not complete" },
      });
    }

    // Test 2: No unhandled errors
    if ((smoke.unhandledErrors?.length ?? 0) === 0) {
      results.push({
        status: "pass",
        name: "No unhandled errors",
      });
    } else {
      results.push({
        status: "fail",
        name: "No unhandled errors",
        error: {
          message: `Found ${smoke.unhandledErrors.length} unhandled errors`,
        },
      });
    }

    // Test 3: All tests passed
    if (
      smoke.sections.tests.completed &&
      smoke.sections.tests.failed === 0 &&
      smoke.sections.tests.passed >= 20
    ) {
      results.push({
        status: "pass",
        name: `All tests (${smoke.sections.tests.passed} passed)`,
      });
    } else {
      // Extract individual test failures for better error reporting
      const failureDetails = smoke.sections.tests.failures
        .map(
          (f) =>
            `  • ${f.testName}: ${f.error}${f.message ? ` (${f.message})` : ""}`,
        )
        .join("\n");

      results.push({
        status: "fail",
        name: "All tests",
        error: {
          message: `Completed: ${smoke.sections.tests.completed}, Passed: ${smoke.sections.tests.passed}, Failed: ${smoke.sections.tests.failed}\n\nFailed tests:\n${failureDetails}`,
        },
      });
    }

    displayTestResults({
      scenarioName: "Playwright Browser Test Results",
      results,
    });

    // Fail the Playwright test if any results failed
    expect(smoke).toBeTruthy();
    expect(smoke.completed).toBe(true);
    expect(smoke.unhandledErrors?.length ?? 0).toBe(0);
    expect(smoke.sections.tests.completed).toBe(true);
    expect(smoke.sections.tests.failed).toBe(0);
    expect(smoke.sections.tests.passed).toBeGreaterThanOrEqual(20);
  });
});
