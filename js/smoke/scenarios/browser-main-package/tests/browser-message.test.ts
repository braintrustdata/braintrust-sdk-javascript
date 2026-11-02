import { test, expect } from "@playwright/test";

test.describe("Braintrust Main Package Browser Build", () => {
  test("should expose the curated root API in a browser", async ({
    page,
    baseURL,
  }) => {
    const consoleMessages: string[] = [];

    // Capture console.info messages
    page.on("console", (msg) => {
      if (msg.type() === "info") {
        consoleMessages.push(msg.text());
      } else if (msg.type() === "error") {
        console.error(`[Browser Console Error] ${msg.text()}`);
      }
    });

    page.on("pageerror", (error) => {
      console.error("[Browser Page Error]", error.message);
    });

    // Load the test page
    const response = await page.goto(
      `${baseURL}/pages/browser-message-test.html`,
      {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      },
    );

    if (!response || !response.ok()) {
      throw new Error(`Failed to load page: ${response?.status()}`);
    }

    // Wait for test to complete
    await page.waitForFunction(
      () => {
        return (window as any).__btBrowserMessageTest?.completed === true;
      },
      { timeout: 10000 },
    );

    // Get test results
    const testResults = await page.evaluate(
      () => (window as any).__btBrowserMessageTest,
    );

    // Log results for debugging
    console.log("Test Results:", testResults);
    console.log("Captured Console Messages:", consoleMessages);

    // Assertions
    expect(testResults).toBeTruthy();
    expect(testResults.completed).toBe(true);
    expect(testResults.importSuccessful).toBe(true);
    expect(testResults.hasInit).toBe(true);
    expect(testResults.hasFlush).toBe(true);
    expect(testResults.removedLegacyExports).toBe(true);
  });
});
