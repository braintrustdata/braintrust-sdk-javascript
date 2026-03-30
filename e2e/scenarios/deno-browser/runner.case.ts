import * as braintrust from "braintrust/browser";
import {
  expectBuildType,
  expectEvalWorks,
  expectMustacheTemplate,
  expectNamedExports,
  expectNunjucksTemplateUnavailable,
  getTestRunId,
  scopedName,
} from "../../helpers/deno-test-helpers.ts";

const scenario = "deno-browser";
const testRunId = getTestRunId();

function createLogger() {
  return braintrust.initLogger({
    projectName: scopedName("e2e-deno-browser"),
  });
}

function metadata(caseName: string) {
  return { case: caseName, scenario, testRunId };
}

Deno.test("deno-browser exposes the expected browser runtime surface", () => {
  expectNamedExports(braintrust, [
    "initLogger",
    "currentSpan",
    "startSpan",
    "log",
    "flush",
    "initDataset",
    "initExperiment",
    "loadPrompt",
    "Prompt",
    "Eval",
    "traced",
    "wrapOpenAI",
    "JSONAttachment",
    "Attachment",
    "invoke",
    "initFunction",
    "Project",
    "PromptBuilder",
    "IDGenerator",
    "BraintrustState",
    "login",
    "_exportsForTestingOnly",
  ]);
  expectBuildType(braintrust, "browser");
  expectMustacheTemplate(braintrust);
  expectNunjucksTemplateUnavailable(braintrust);
});

Deno.test(
  "deno-browser can run Eval locally without sending logs",
  async () => {
    await expectEvalWorks(braintrust);
  },
);

Deno.test("deno-browser emits trace payloads over HTTP", async () => {
  const logger = createLogger();

  const basicSpan = logger.startSpan({
    name: "deno browser basic span",
    event: {
      metadata: metadata("basic-span"),
    },
  });
  basicSpan.log({
    expected: "Paris",
    input: "What is the capital of France?",
    metadata: {
      ...metadata("basic-span"),
      transport: "http",
    },
    output: "Paris",
  });
  basicSpan.end();

  const attachmentSpan = logger.startSpan({
    name: "deno browser json attachment span",
    event: {
      metadata: metadata("json-attachment"),
    },
  });
  attachmentSpan.log({
    input: {
      transcript: new braintrust.JSONAttachment(
        {
          foo: "bar",
          nested: {
            array: [1, 2, 3],
            ok: true,
          },
        },
        {
          filename: "conversation_transcript.json",
          pretty: true,
        },
      ),
      type: "chat_completion",
    },
    metadata: metadata("json-attachment"),
    output: {
      attachment: true,
    },
  });
  attachmentSpan.end();

  await braintrust.traced(
    async (parentSpan) => {
      const childSpan = braintrust.startSpan({
        name: "deno browser child span",
        event: {
          input: {
            step: "child",
            testRunId,
          },
          metadata: metadata("child-span"),
        },
      });

      childSpan.log({
        output: {
          phase: "child",
          ok: true,
        },
      });
      childSpan.end();

      parentSpan.log({
        output: {
          phase: "parent",
          ok: true,
        },
      });
    },
    {
      name: "deno browser parent span",
      event: {
        input: {
          phase: "parent",
          testRunId,
        },
        metadata: metadata("parent-span"),
      },
    },
  );

  await braintrust.traced(
    async () => {
      await braintrust.traced(
        async () => {
          await braintrust.traced(
            async () => {
              braintrust.currentSpan().log({
                metadata: metadata("nested-grandchild"),
                output: {
                  depth: 3,
                },
              });
            },
            {
              name: "deno browser nested grandchild span",
              event: {
                metadata: metadata("nested-grandchild"),
              },
            },
          );
        },
        {
          name: "deno browser nested child span",
          event: {
            metadata: metadata("nested-child"),
          },
        },
      );
    },
    {
      name: "deno browser nested parent span",
      event: {
        metadata: metadata("nested-parent"),
      },
    },
  );

  await braintrust.traced(
    async () => {
      const activeSpan = braintrust.currentSpan();
      activeSpan.log({
        metadata: metadata("current-span"),
        output: {
          observedSpanId: activeSpan.spanId,
        },
      });
    },
    {
      name: "deno browser current span",
      event: {
        metadata: metadata("current-span"),
      },
    },
  );

  await logger.flush();
});
