import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { wrapGoogleGenAI } from "braintrust";
import { runMain, runTracedScenario } from "../../helpers/provider-runtime.mjs";

const packageName = process.env.GOOGLE_GENAI_PACKAGE_NAME;
const sdk =
  process.env.GOOGLE_GENAI_MODE === "auto-cjs"
    ? createRequire(import.meta.url)(packageName)
    : await import(packageName);
const { GoogleGenAI } =
  process.env.GOOGLE_GENAI_MODE === "wrapped" ? wrapGoogleGenAI(sdk) : sdk;
const client = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
  httpOptions: {
    baseUrl: process.env.GOOGLE_GENAI_BASE_URL,
    apiVersion: "v1beta",
  },
});

runMain(() =>
  runTracedScenario({
    projectNameBase: "tmp-luca",
    rootName: "google-genai-decisions-root",
    metadata: { scenario: "google-genai-decisions-instrumentation" },
    callback: async () => {
      const response = await client.decisions.create(
        {
          model: "gemini-decision-1",
          api_version: "v1beta",
          input: "The customer says: Thank you, the problem is fixed!",
          questions: {
            resolved: {
              type: "noul",
              instructions: "Is the problem resolved?",
            },
            sentiment: {
              type: "choice",
              instructions: "What is the customer's sentiment?",
              criteria: {
                positive: "Happy or thankful",
                negative: "Unhappy or angry",
              },
            },
            urgency: {
              type: "score",
              instructions: "Rate the urgency of the request.",
              criteria: [
                "No action needed",
                "Action needed soon",
                "Immediate action needed",
              ],
            },
          },
        },
        { timeout: 30_000 },
      );
      assert.equal(response.answers.resolved.type, "noul");
      assert.equal(response.answers.sentiment.type, "choice");
      assert.equal(response.answers.urgency.type, "score");
      const image = await readFile(
        new URL("./test-image.png", import.meta.url),
      );
      const multimodal = await client.decisions.create({
        model: "gemini-decision-1",
        input: [
          {
            type: "image",
            mime_type: "image/png",
            data: image.toString("base64"),
          },
        ],
        questions: {
          image: { type: "noul", instructions: "Is this an image?" },
        },
      });
      assert.equal(multimodal.answers.image.type, "noul");
    },
  }),
);
