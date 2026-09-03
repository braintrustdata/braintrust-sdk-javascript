declare global {
  interface Window {
    __btBrowserMessageTest?: {
      completed: boolean;
      consoleMessages: string[];
      importSuccessful: boolean;
      hasInit: boolean;
      hasFlush: boolean;
      removedLegacyExports: boolean;
    };
  }
}

// Capture console.info messages BEFORE importing braintrust
const capturedMessages: string[] = [];
const originalConsoleInfo = console.info;
console.info = (...args: any[]) => {
  const message = args.join(" ");
  capturedMessages.push(message);
  originalConsoleInfo.apply(console, args);
};

// Import from main package browser export AFTER setting up console capture
// This must be done dynamically to ensure console.info is overridden first
const braintrust = await import("braintrust");

// Test that imports work
const importSuccessful = true;
const hasInit = typeof braintrust.init === "function";
const hasFlush = typeof braintrust.flush === "function";
const removedLegacyExports =
  !("newId" in braintrust) && !("traceable" in braintrust);

// Store results
window.__btBrowserMessageTest = {
  completed: true,
  consoleMessages: capturedMessages,
  importSuccessful,
  hasInit,
  hasFlush,
  removedLegacyExports,
};

// Display results
const output = document.getElementById("output");
if (output) {
  output.innerHTML = `
    <h2>Test Results</h2>
    <ul>
      <li>Import successful: ${importSuccessful ? "✓" : "✗"}</li>
      <li>Has init function: ${hasInit ? "✓" : "✗"}</li>
      <li>Has flush function: ${hasFlush ? "✓" : "✗"}</li>
      <li>Legacy exports removed: ${removedLegacyExports ? "✓" : "✗"}</li>
      <li>Console messages captured: ${capturedMessages.length}</li>
    </ul>
    <h3>Console Messages:</h3>
    <pre>${capturedMessages.join("\n")}</pre>
  `;
}
