import assert from "node:assert/strict";
import { initLogger } from "braintrust";
import OpenAI from "openai";
import { getTestRunId, scopedName } from "../../helpers/scenario-runtime.ts";
import config, { b } from "./config.ts";

assert.deepEqual(config, { a: 1 });
assert.equal(b, 2);
assert.deepEqual(Object.keys(await import("./config.ts")), ["b", "default"]);

const testRunId = getTestRunId();
const logger = initLogger({
  projectName: scopedName("e2e-ts-exec-loader", testRunId),
});
const client = new OpenAI();
await logger.traced(
  async (span) => {
    await client.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18",
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 5,
      temperature: 0,
    });
    span.log({ output: { config, b } });
  },
  {
    name: "ts-exec-entry",
    event: { metadata: { testRunId, scenario: "ts-exec-loader" } },
  },
);
await logger.flush();
console.log("entry ran");
