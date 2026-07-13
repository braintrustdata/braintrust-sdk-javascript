import {
  initLogger,
  wrapLangSmithClient,
  wrapLangSmithRunTrees,
  wrapLangSmithTraceable,
} from "braintrust";
import { scopedName } from "../../helpers/provider-runtime.mjs";

export const LANGSMITH_SCENARIO_TIMEOUT_MS = 120_000;
export const LANGSMITH_SCENARIO_SPECS = [
  {
    dependencyName: "langsmith-v0330",
    snapshotName: "langsmith-v0-3-30",
  },
  {
    dependencyName: "langsmith-v0511",
    snapshotName: "langsmith-v0-5-11",
  },
  {
    dependencyName: "langsmith-v081",
    snapshotName: "langsmith-v0-8-1",
  },
];

const SCENARIO_NAME = "langsmith-instrumentation";
const IDS = {
  client: "11111111-1111-4111-8111-111111111111",
  batchParent: "22222222-2222-4222-8222-222222222222",
  batchChild: "33333333-3333-4333-8333-333333333333",
};

export async function loadLangSmithNamespaces(dependencyName) {
  return {
    root: await import(dependencyName),
    client: await import(`${dependencyName}/client`),
    openAI: await import("openai"),
    openAIWrapper: await import(`${dependencyName}/wrappers`),
    runTrees: await import(`${dependencyName}/run_trees`),
    traceable: await import(`${dependencyName}/traceable`),
  };
}

export async function runLangSmithScenario({
  includeLangChain = false,
  namespaces,
  wrapped,
}) {
  const rootNamespace = namespaces.root;
  const clientNamespace = wrapped
    ? wrapLangSmithClient(namespaces.client)
    : namespaces.client;
  const runTreesNamespace = wrapped
    ? wrapLangSmithRunTrees(namespaces.runTrees)
    : namespaces.runTrees;
  const traceableNamespace = wrapped
    ? wrapLangSmithTraceable(namespaces.traceable)
    : namespaces.traceable;

  rootNamespace.overrideFetchImplementation(
    async () =>
      new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
        status: 202,
      }),
  );

  const logger = initLogger({
    projectName: scopedName("e2e-langsmith-instrumentation"),
  });
  const client = new clientNamespace.Client({
    apiKey: "ls-test-key",
    apiUrl: "http://langsmith.invalid",
    autoBatchTracing: false,
    timeout_ms: 5_000,
  });

  const retrieveContext = traceableNamespace.traceable(
    async ({ question }) => [
      {
        content: "Refund requests are accepted within 30 days of purchase.",
        title: "Refund policy",
      },
    ],
    {
      client,
      metadata: {
        data_source: "support-kb",
        scenario: SCENARIO_NAME,
      },
      name: "retrieve-context",
      processInputs: (inputs) => ({ query: inputs.question }),
      processOutputs: ({ outputs }) => ({
        documents: outputs.map((document) => document.title),
      }),
      run_type: "retriever",
      tags: ["knowledge-base"],
    },
  );

  const openAI = namespaces.openAIWrapper.wrapOpenAI(
    new namespaces.openAI.default({
      apiKey: "openai-test-key",
      baseURL: "https://openai.invalid/v1",
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: {
                  content:
                    "Refund requests are accepted within 30 days of purchase.",
                  role: "assistant",
                },
              },
            ],
            created: 1_783_900_800,
            id: "chatcmpl-langsmith-e2e",
            model: "gpt-4o-mini-2024-07-18",
            object: "chat.completion",
            usage: {
              completion_tokens: 7,
              prompt_tokens: 18,
              prompt_tokens_details: { cached_tokens: 4 },
              total_tokens: 25,
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
    }),
    {
      client,
      metadata: { deployment: "local-fixture", scenario: SCENARIO_NAME },
      tags: ["openai"],
    },
  );

  const supportAssistant = traceableNamespace.traceable(
    async ({ question }) => {
      const documents = await retrieveContext({ question });
      const completion = await openAI.chat.completions.create(
        {
          max_tokens: 64,
          messages: [
            {
              content: `Answer using only this context: ${documents[0].content}`,
              role: "system",
            },
            { content: question, role: "user" },
          ],
          model: "gpt-4o-mini",
          temperature: 0,
        },
        {
          langsmithExtra: {
            metadata: { customer_tier: "enterprise" },
            tags: ["chat-completion"],
          },
        },
      );

      return {
        answer: completion.choices[0].message.content,
        source: documents[0].title,
      };
    },
    {
      client,
      metadata: {
        customer_id: "customer-123",
        scenario: SCENARIO_NAME,
      },
      name: "support-assistant",
      run_type: "chain",
      tags: ["support"],
    },
  );
  await supportAssistant({ question: "What is the refund window?" });

  const failedTraceable = traceableNamespace.traceable(
    async () => {
      throw new Error("customer record unavailable");
    },
    {
      client,
      metadata: { scenario: SCENARIO_NAME },
      name: "lookup-customer-record",
      run_type: "tool",
    },
  );
  await failedTraceable().catch(() => undefined);

  const manualParent = new runTreesNamespace.RunTree({
    client,
    extra: { metadata: { scenario: SCENARIO_NAME } },
    inputs: { question: "Which policy applies?" },
    name: "manual-rag-pipeline",
    run_type: "chain",
  });
  await manualParent.postRun();
  const manualChild = manualParent.createChild({
    extra: {
      metadata: {
        ls_model_name: "manual-model",
        ls_provider: "manual-provider",
      },
    },
    inputs: { text: "Which policy applies?" },
    name: "embed-query",
    run_type: "embedding",
    tags: ["manual"],
  });
  await manualChild.postRun();
  manualChild.addEvent({ name: "new_token", time: new Date().toISOString() });
  await manualChild.end({
    embedding: [0.1, 0.2],
    usage_metadata: {
      input_tokens: 3,
      output_tokens: 0,
      total_tokens: 3,
      input_token_details: { cache_read: 1 },
    },
  });
  await manualChild.patchRun();
  await manualParent.end({ matched_document: "Refund policy" });
  await manualParent.patchRun();

  const now = Date.now();
  await client.createRun({
    dotted_order: `20260713T000000000000Z${IDS.client}`,
    extra: { metadata: { scenario: SCENARIO_NAME } },
    id: IDS.client,
    inputs: { query: "refund window", top_k: 3 },
    name: "direct-search-index",
    run_type: "retriever",
    start_time: now,
    trace_id: IDS.client,
  });
  await client.updateRun(IDS.client, {
    end_time: now + 10,
    outputs: { documents: ["Refund policy"] },
    trace_id: IDS.client,
  });

  await client.batchIngestRuns({
    runCreates: [
      {
        dotted_order: `20260713T000000000000Z${IDS.batchParent}.20260713T000000000001Z${IDS.batchChild}`,
        id: IDS.batchChild,
        inputs: { document: "Refund requests are accepted within 30 days." },
        name: "extract-keywords",
        parent_run_id: IDS.batchParent,
        run_type: "tool",
        start_time: now,
        trace_id: IDS.batchParent,
      },
      {
        dotted_order: `20260713T000000000000Z${IDS.batchParent}`,
        extra: { metadata: { scenario: SCENARIO_NAME } },
        id: IDS.batchParent,
        inputs: { document_count: 1 },
        name: "offline-document-enrichment",
        run_type: "prompt",
        start_time: now,
        trace_id: IDS.batchParent,
      },
    ],
    runUpdates: [
      {
        end_time: now + 20,
        id: IDS.batchChild,
        outputs: { keywords: ["refund", "30 days"] },
        parent_run_id: IDS.batchParent,
        trace_id: IDS.batchParent,
      },
      {
        end_time: now + 30,
        id: IDS.batchParent,
        outputs: { enriched_documents: 1 },
        trace_id: IDS.batchParent,
      },
    ],
  });

  if (includeLangChain) {
    const { RunnableLambda } = await import("@langchain/core/runnables");
    const runnable = RunnableLambda.from(
      async (value) => `${value}!`,
    ).withConfig({ runName: "langchain-dedupe" });
    await runnable.invoke("provider-free");
  }

  await client.flush?.();
  await logger.flush();
}
