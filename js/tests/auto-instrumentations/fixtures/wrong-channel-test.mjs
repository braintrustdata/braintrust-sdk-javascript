import Anthropic from "@anthropic-ai/sdk";
import { _internalIso as iso } from "../../../dist/index.mjs";

// Subscribe to WRONG channel name (old bug)
let eventReceived = false;
const wrongChannel = iso.newTracingChannel(
  "orchestrion:anthropic:messages.create",
);

wrongChannel.subscribe({
  start: () => {
    eventReceived = true;
  },
});

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

await client.messages.create({
  model: "claude-3-sonnet-20240229",
  max_tokens: 10,
  messages: [{ role: "user", content: "Hi" }],
});

if (eventReceived) {
  console.error("ERROR: Event received on WRONG channel!");
  process.exit(1);
} else {
  console.log("SUCCESS: Event correctly NOT received on wrong channel");
  process.exit(0);
}
