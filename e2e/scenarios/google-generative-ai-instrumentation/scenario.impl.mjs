import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { wrapGoogleGenerativeAI } from "braintrust";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "google-generative-ai-instrumentation-root";
export const MODEL = "gemini-2.5-flash";
export const EMBEDDING_MODEL = "gemini-embedding-001";

export async function runScenario(sdk, wrapped) {
  const original = new sdk.GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const client = wrapped ? wrapGoogleGenerativeAI(original) : original;
  if (wrapped) assert.equal(wrapGoogleGenerativeAI(client), client);
  const options = { baseUrl: process.env.GOOGLE_GENERATIVE_AI_BASE_URL };
  const model = client.getGenerativeModel(
    {
      model: MODEL,
      systemInstruction: "Give short, factual answers.",
      generationConfig: {
        maxOutputTokens: 128,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
    options,
  );
  await runTracedScenario({
    rootName: ROOT_NAME,
    projectNameBase: "tmp-luca-e2e-google-generative-ai",
    metadata: { scenario: "google-generative-ai-instrumentation" },
    callback: async () => {
      await runOperation("generation", "generation", async () => {
        const result = await model.generateContent(
          "What is the capital of France?",
        );
        assert.match(result.response.text(), /Paris/);
      });
      await runOperation("image", "image", async () => {
        const data = (
          await readFile(new URL("./test-image.png", import.meta.url))
        ).toString("base64");
        const result = await model.generateContent([
          "Describe this image briefly.",
          { inlineData: { data, mimeType: "image/png" } },
        ]);
        assert.ok(result.response.text());
      });
      await runOperation("stream", "stream", async () => {
        const result = await model.generateContentStream([
          "Count from one to three.",
        ]);
        let text = "";
        for await (const chunk of result.stream) text += chunk.text();
        assert.ok(text.length > 0);
        assert.equal((await result.response).text(), text);
      });
      await runOperation("response-only", "response-only", async () => {
        const result = await model.generateContentStream("Say hello.");
        assert.ok((await result.response).text());
      });
      const chat = model.startChat({
        history: [
          { role: "user", parts: [{ text: "My name is Ada." }] },
          { role: "model", parts: [{ text: "Hello, Ada." }] },
        ],
      });
      await runOperation("chat", "chat", async () => {
        assert.match(
          (await chat.sendMessage("What is my name?")).response.text(),
          /Ada/,
        );
      });
      await runOperation("chat-stream", "chat-stream", async () => {
        const result = await chat.sendMessageStream(
          "Spell my name letter by letter.",
        );
        for await (const chunk of result.stream)
          assert.equal(typeof chunk.text(), "string");
        assert.ok((await result.response).text());
        assert.equal((await chat.getHistory()).length, 6);
      });
      await runOperation("tools", "tools", async () => {
        const result = await model.generateContent({
          contents: [
            { role: "user", parts: [{ text: "Get the weather in Paris." }] },
          ],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "get_weather",
                  description: "Get weather for a city",
                  parameters: {
                    type: "OBJECT",
                    properties: { city: { type: "STRING" } },
                    required: ["city"],
                  },
                },
              ],
            },
          ],
          toolConfig: { functionCallingConfig: { mode: "ANY" } },
        });
        assert.equal(result.response.functionCalls()[0].name, "get_weather");
      });
      for (const embeddingModel of [EMBEDDING_MODEL, "gemini-embedding-2"]) {
        const embeddings = client.getGenerativeModel(
          { model: embeddingModel },
          options,
        );
        const suffix = embeddingModel === EMBEDDING_MODEL ? "" : "-with-usage";
        await runOperation(`embedding${suffix}`, "embedding", async () => {
          const result = await embeddings.embedContent({
            content: { role: "user", parts: [{ text: "Braintrust tracing" }] },
            outputDimensionality: 32,
          });
          assert.equal(result.embedding.values.length, 32);
          if (suffix) assert.ok(result.usageMetadata.promptTokenCount > 0);
        });
        await runOperation(
          `batch-embedding${suffix}`,
          "batch-embedding",
          async () => {
            const result = await embeddings.batchEmbedContents({
              requests: ["Hello", "World"].map((text) => ({
                content: { role: "user", parts: [{ text }] },
                outputDimensionality: 32,
              })),
            });
            assert.equal(result.embeddings.length, 2);
            if (suffix) assert.ok(result.usageMetadata.promptTokenCount > 0);
          },
        );
      }
      await runOperation("error", "error", async () => {
        const invalidModel = client.getGenerativeModel(
          { model: "braintrust-nonexistent-model" },
          options,
        );
        await assert.rejects(
          () => invalidModel.generateContent("Hello"),
          /404/,
        );
      });
    },
  });
}
