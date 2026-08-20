import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  completeGeminiDeveloperBatchTrace,
  startGeminiDeveloperBatchTrace,
} from "braintrust";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const ROOT_NAME = "google-genai-batch-helper-root";
const PROVIDER_MODEL = "models/gemini-2.5-flash-001";

const typecheck = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("./node_modules/typescript/bin/tsc", import.meta.url),
    ),
    "--lib",
    "ES2022,DOM,DOM.Iterable",
    "--module",
    "Preserve",
    "--moduleResolution",
    "Bundler",
    "--noEmit",
    "--skipLibCheck",
    "--strict",
    "--target",
    "ES2022",
    "batch-type-compatibility.ts",
  ],
  { cwd: new URL(".", import.meta.url), encoding: "utf8" },
);
if (typecheck.status !== 0) {
  throw new Error(
    `Google GenAI batch type compatibility failed:\n${typecheck.stdout}${typecheck.stderr}`,
  );
}

await runTracedScenario({
  callback: async () => {
    await runOperation(
      "google-batch-inline-operation",
      "batch-inline",
      async () => {
        const createTime = new Date();
        const params = {
          model: "models/gemini-2.5-flash",
          src: [
            {
              contents: "Reply with exactly INLINE ONE.",
              config: {
                httpOptions: {
                  headers: { Authorization: "batch-secret-header" },
                },
                maxOutputTokens: 24,
                temperature: 0,
              },
              metadata: { privateLabel: "batch-secret-metadata" },
            },
            {
              contents: "This synthetic request fails.",
            },
          ],
        };
        const created = {
          createTime: createTime.toISOString(),
          model: PROVIDER_MODEL,
          name: "batches/e2e-inline",
          state: "JOB_STATE_PENDING",
        };
        const traceContext = await startGeminiDeveloperBatchTrace({
          batch: created,
          params,
        });
        if (!traceContext) {
          throw new Error("Google GenAI batch start returned no context");
        }

        const completed = {
          ...created,
          dest: {
            inlinedResponses: [
              {
                response: {
                  arbitraryExtension: "private-response-extension",
                  candidates: [
                    {
                      content: {
                        parts: [{ text: "INLINE ONE" }],
                        role: "model",
                      },
                      groundingMetadata: {
                        webSearchQueries: ["inline one query"],
                      },
                    },
                  ],
                  sdkHttpResponse: {
                    headers: { Authorization: "batch-response-secret" },
                  },
                  usageMetadata: {
                    candidatesTokenCount: 2,
                    promptTokenCount: 5,
                    totalTokenCount: 7,
                  },
                },
              },
              {
                error: {
                  code: 400,
                  message: "Synthetic batch error",
                },
              },
            ],
          },
          completionStats: {
            failedCount: "1",
            incompleteCount: "0",
            successfulCount: "1",
          },
          state: "JOB_STATE_SUCCEEDED",
          updateTime: new Date(createTime.getTime() + 120_000).toISOString(),
        };
        const completion = await completeGeminiDeveloperBatchTrace({
          batch: completed,
          params,
          traceContext,
        });
        if (completion.batch !== completed) {
          throw new Error("Google GenAI batch completion changed identity");
        }
        if (completion.traceContext !== traceContext) {
          throw new Error("Google GenAI batch completion changed context");
        }
      },
    );
  },
  metadata: {
    scenario: "google-genai-batch-helper",
  },
  projectNameBase: "e2e-google-genai-batch-helper",
  rootName: ROOT_NAME,
});
