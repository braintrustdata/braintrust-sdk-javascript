import assert from "node:assert/strict";
import { BraintrustLangChainCallbackHandler } from "braintrust";
import {
  runMain,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const { ChatAnthropic } = await import(
  process.env.LANGCHAIN_ANTHROPIC_PACKAGE_NAME
);
const MODEL = "claude-haiku-4-5-20251001";

runMain(async () => {
  await runTracedScenario({
    rootName: "langchain-anthropic-root",
    projectNameBase: "tmp-luca-langchain-anthropic",
    metadata: { scenario: "langchain-anthropic" },
    callback: async () => {
      for (const mode of ["manual", "auto"]) {
        // The hook respects an explicit handler and injects one when absent.
        const callbacks =
          mode === "manual" ? [new BraintrustLangChainCallbackHandler()] : [];
        for (const operation of ["invoke", "streaming-invoke", "stream"]) {
          await runOperation(
            `anthropic-${mode}-${operation}`,
            operation,
            async () => {
              // Distinct requests keep repeated streaming calls unambiguous in replay.
              const prompt = `Say hi in one word. This is the ${mode} ${operation} check.`;
              const model = new ChatAnthropic({
                model: MODEL,
                maxTokens: 16,
                streaming: operation === "streaming-invoke",
              });
              let response;
              if (operation === "stream") {
                for await (const chunk of await model.stream(prompt, {
                  callbacks,
                })) {
                  response = response ? response.concat(chunk) : chunk;
                }
              } else {
                response = await model.invoke(prompt, { callbacks });
              }
              assert.ok(response.content.length > 0);
              assert.ok(response.usage_metadata.input_tokens > 0);
              assert.ok(response.usage_metadata.output_tokens > 0);
              if (operation === "invoke") {
                assert.equal(response.response_metadata.model, MODEL);
              } else if (
                process.env.LANGCHAIN_ANTHROPIC_PACKAGE_NAME ===
                "langchain-anthropic-v1"
              ) {
                // Exercise the real LangChain omission, without modifying responses.
                assert.equal(response.response_metadata.model, undefined);
              }
            },
          );
        }
      }
    },
  });
});
