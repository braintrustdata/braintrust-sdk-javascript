import Anthropic from "@anthropic-ai/sdk";
import { initLogger, _exportsForTestingOnly } from "../../../dist/index.mjs";

// Use test background logger to capture spans
const backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();

// Simulate login
await _exportsForTestingOnly.simulateLoginForTests();

initLogger({
  projectName: "auto-instrumentation-test",
  projectId: "test-project-id",
});

// Create Anthropic client with mocked fetch
const mockFetch = async (url, options) => {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": "application/json",
    }),
    json: async () => ({
      id: "msg_test123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Test response" }],
      model: "claude-3-sonnet-20240229",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    }),
  };
};

const client = new Anthropic({
  apiKey: "test-key",
  fetch: mockFetch,
});

try {
  await client.messages.create({
    model: "claude-3-sonnet-20240229",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello!" }],
  });

  // Drain spans
  const spans = await backgroundLogger.drain();

  // Output spans for validation
  for (const span of spans) {
    console.log("SPAN_DATA:", JSON.stringify(span));
  }

  console.log("SUCCESS: API call completed");
  process.exit(0);
} catch (error) {
  console.error("ERROR:", error.message);
  process.exit(1);
}
