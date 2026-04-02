import Anthropic from "@anthropic-ai/sdk";
import { _internalIso as iso } from "../../../dist/index.mjs";

// Subscribe to the channel we expect to be used
let eventReceived = false;
const channel = iso.newTracingChannel(
  "orchestrion:@anthropic-ai/sdk:messages.create",
);

channel.subscribe({
  start: (event) => {
    eventReceived = true;
    console.log("CHANNEL_EVENT_RECEIVED: true");
  },
});

// Create client with mocked fetch
const mockFetch = async () => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Test" }],
    model: "claude-3-sonnet-20240229",
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
});

const client = new Anthropic({
  apiKey: "test-key",
  fetch: mockFetch,
});

try {
  await client.messages.create({
    model: "claude-3-sonnet-20240229",
    max_tokens: 10,
    messages: [{ role: "user", content: "Hi" }],
  });

  if (eventReceived) {
    console.log("SUCCESS: Channel event received on correct channel");
    process.exit(0);
  } else {
    console.error("ERROR: Channel event NOT received - name mismatch!");
    process.exit(1);
  }
} catch (error) {
  console.error("ERROR:", error.message);
  process.exit(1);
}
