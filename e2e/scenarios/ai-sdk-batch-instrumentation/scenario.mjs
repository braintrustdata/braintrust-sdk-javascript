import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import {
  startAISDKBatchTrace,
  initLogger,
  completeAISDKBatchTrace,
  wrapAISDK,
} from "braintrust";

const ai = await import(process.env.AI_SDK_PACKAGE_NAME);
const sdk =
  process.env.AI_SDK_BATCH_MODE === "manual-with-auto" ? wrapAISDK(ai) : ai;
const provider = ai.createGateway({
  apiKey:
    process.env.AI_GATEWAY_API_KEY ??
    (process.env.BRAINTRUST_E2E_CASSETTE_MODE === "replay"
      ? "cassette-placeholder"
      : undefined),
  baseURL: process.env.BRAINTRUST_E2E_AI_GATEWAY_BASE_URL,
});
const logger = initLogger({
  projectName: process.env.BRAINTRUST_E2E_PROJECT_NAME || "tmp-luca",
});
const handoffPath = process.env.AI_SDK_BATCH_HANDOFF_PATH;
const phase = process.env.AI_SDK_BATCH_PHASE;

if (phase === "submit") {
  await logger.traced(
    async () => {
      const requests = ["one", "two"].map((id) => ({
        id,
        type: "text",
        model: "google/gemini-2.5-flash",
        prompt: `Reply with only the word ${id}.`,
        maxOutputTokens: 16,
        reasoning: "none",
        temperature: 0,
      }));
      const startTime = Date.now() / 1000;
      const batch = await sdk.experimental_startBatch({ provider, requests });
      const context = await startAISDKBatchTrace({
        batch,
        requests,
        startTime,
      });
      assert.equal(typeof context, "string");
      // Persist the provider reference, not its secret-bearing start response.
      await writeFile(
        handoffPath,
        JSON.stringify({
          batch: {
            version: batch.version,
            id: batch.id,
            provider: batch.provider,
          },
          context,
          requests,
          producerPid: process.pid,
        }),
        { mode: 0o600 },
      );
    },
    {
      name: "ai-sdk-batch",
      event: {
        metadata: {
          scenario: "ai-sdk-batch-instrumentation",
          variant: process.env.AI_SDK_PACKAGE_NAME,
          mode: process.env.AI_SDK_BATCH_MODE,
          testRunId: process.env.BRAINTRUST_E2E_RUN_ID,
        },
      },
    },
  );
} else {
  const { batch, context, requests, producerPid } = JSON.parse(
    await readFile(handoffPath, "utf8"),
  );
  assert.notEqual(producerPid, process.pid);
  let status;
  const deadline = Date.now() + 20 * 60 * 1000;
  do {
    status = await sdk.experimental_getBatchStatus({ provider, batch });
    if (status.status !== "pending") break;
    assert.ok(
      Date.now() < deadline,
      "Batch did not finish within the recording timeout",
    );
    if (process.env.BRAINTRUST_E2E_CASSETTE_MODE !== "replay")
      await setTimeout(10_000);
  } while (true);
  assert.equal(status.status, "completed");
  const results = [];
  for await (const item of sdk.experimental_getBatchResults({
    provider,
    batch,
  })) {
    assert.equal(item.status, "succeeded");
    assert.equal(item.type, "text");
    assert.ok(item.text.length > 0);
    results.push(item);
  }
  assert.deepEqual(results.map((item) => item.id).sort(), ["one", "two"]);
  await completeAISDKBatchTrace({ batch, requests, context, status, results });
  // Repeating manual capture updates the same rows without provider requests.
  await completeAISDKBatchTrace({ batch, requests, context, status, results });
}
await logger.flush();
