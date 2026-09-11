import assert from "node:assert/strict";
import { wrapAnthropic } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "anthropic-vertex-instrumentation-root";
export const SCENARIO_NAME = "anthropic-vertex-instrumentation";

const MODEL = "claude-haiku-4-5@20251001";
const PROJECT_ID = "vertex-e2e-project";

function createVertexFetch() {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    assert.equal(init?.method, "POST");
    assert.equal(typeof init.body, "string");
    const body = JSON.parse(init.body);
    assert.equal(body.anthropic_version, "vertex-2023-10-16");
    assert.equal(body.model, undefined);
    assert.equal(
      url.pathname,
      `/v1/projects/${PROJECT_ID}/locations/global/publishers/anthropic/models/${MODEL}:${
        body.stream ? "streamRawPredict" : "rawPredict"
      }`,
    );

    const prompt = body.messages[0].content;
    const text = prompt.includes("Count")
      ? "one two three"
      : prompt.includes("Hello")
        ? "Hello"
        : "OK";
    const message = {
      id: "msg_vertex_e2e_fixture",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3 },
    };

    if (!body.stream) {
      return new Response(JSON.stringify(message), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }

    const events = [
      {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 3 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      },
    );
  };
}

async function runAnthropicVertexInstrumentationScenario(options) {
  const baseClient = new options.AnthropicVertex({
    authClient: {
      projectId: PROJECT_ID,
      async getRequestHeaders() {
        return new Headers({ authorization: "Bearer vertex-test-token" });
      },
    },
    baseURL: "https://aiplatform.googleapis.com/v1",
    fetch: createVertexFetch(),
    maxRetries: 0,
    projectId: PROJECT_ID,
    region: "global",
  });
  const client = options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;

  await runTracedScenario({
    callback: async () => {
      for (const beta of [false, true]) {
        const messages = beta ? client.beta.messages : client.messages;
        const prefix = beta ? "beta-" : "";
        await runOperation(
          `anthropic-vertex-${prefix}create-operation`,
          "create",
          async () => {
            const result = await messages
              .create({
                model: MODEL,
                max_tokens: 32,
                messages: [{ role: "user", content: "Reply with exactly OK." }],
                temperature: 0,
              })
              .withResponse();
            assert.equal(result.response.status, 200);
            assert.equal(result.data.role, "assistant");
          },
        );
        await runOperation(
          `anthropic-vertex-${prefix}stream-operation`,
          "stream",
          async () => {
            const stream = await messages.create({
              model: MODEL,
              max_tokens: 32,
              messages: [{ role: "user", content: "Count from one to three." }],
              stream: true,
              temperature: 0,
            });
            const events = await collectAsync(stream);
            assert(events.some((event) => event.type === "message_stop"));
          },
        );
        await runOperation(
          `anthropic-vertex-${prefix}stream-helper-operation`,
          "stream-helper",
          async () => {
            const stream = messages.stream({
              model: MODEL,
              max_tokens: 32,
              messages: [
                { role: "user", content: "Reply with exactly Hello." },
              ],
              temperature: 0,
            });
            const result = await stream.finalMessage();
            assert.equal(result.role, "assistant");
            assert(result.content.length > 0);
          },
        );
      }
    },
    metadata: { scenario: SCENARIO_NAME },
    projectNameBase: "tmp-luca-e2e-anthropic-vertex-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedAnthropicVertexInstrumentation(options) {
  await runAnthropicVertexInstrumentationScenario({
    decorateClient: wrapAnthropic,
    ...options,
  });
}

export async function runAutoAnthropicVertexInstrumentation(options) {
  await runAnthropicVertexInstrumentationScenario(options);
}
