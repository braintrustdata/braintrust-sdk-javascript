/**
 * Reproduction scenario for "Body is unusable: Body has already been read".
 *
 * Uses a real Node.js HTTP server so OpenAI SDK receives genuine undici
 * Response objects (not in-process mocks), matching the client's environment.
 *
 * Root cause: chat.completions.parse calls create()._thenUnwrap(...), producing
 * two APIPromise instances (P1 from create, P2 from _thenUnwrap) that share the
 * same responsePromise. Both create and parse are instrumented by hook.mjs, so
 * tracePromise calls void P1.then(...) AND void P2.then(...). Each eventually
 * calls response.json() on the same Response object. Mock/cassette responses
 * allow multiple reads (in-memory buffer); real undici responses do not.
 *
 * Run with:
 *   node --import braintrust/hook.mjs scenario.real-http.mjs
 */
import * as http from "node:http";
import OpenAI from "openai-v6-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";

const CHAT_RESPONSE = JSON.stringify({
  id: "chatcmpl-fixture",
  object: "chat.completion",
  created: 1740000000,
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: '{"answer":4}' },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
});

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(CHAT_RESPONSE);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

runMain(async () => {
  const { server, port } = await startServer();
  try {
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: `http://127.0.0.1:${port}/v1`,
    });

    // .parse() internally calls create()._thenUnwrap(...) — this is what triggers
    // the double body read when both create and parse are instrumented.
    const result = await client.chat.completions.parse({
      model: "gpt-4o-mini-2024-07-18",
      messages: [{ role: "user", content: "What is 2+2?" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "math_response",
          schema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
          },
        },
      },
      max_tokens: 12,
    });

    if (!result.choices[0].message.parsed) {
      throw new Error(`Unexpected response: ${JSON.stringify(result)}`);
    }
  } finally {
    server.close();
  }
});
