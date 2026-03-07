import OpenAI from "openai";
import { initLogger, _exportsForTestingOnly } from "../../../dist/index.mjs";

const backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
await _exportsForTestingOnly.simulateLoginForTests();

const logger = initLogger({
  projectName: "auto-instrumentation-test",
  projectId: "test-project-id",
});

// Create OpenAI client with mocked fetch
const mockFetch = async (url, options) => {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({
      id: "chatcmpl-test123",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Test response" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }),
  };
};

const client = new OpenAI({
  apiKey: "test-key",
  fetch: mockFetch,
});

try {
  const completion = await client.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: "Hello!" }],
  });

  const spans = await backgroundLogger.drain();

  for (const span of spans) {
    console.log("SPAN_DATA:", JSON.stringify(span));
  }

  console.log("SUCCESS: API call completed");
  process.exit(0);
} catch (error) {
  console.error("ERROR:", error.message);
  process.exit(1);
}
