import { wrapVoyageAI } from "braintrust";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "voyageai-instrumentation-root";
export const SCENARIO_NAME = "voyageai-instrumentation";

const RESPONSES_BY_PATH = {
  "/embeddings": {
    data: [{ embedding: [0.1, 0.2, 0.3], index: 0, object: "embedding" }],
    model: "voyage-4",
    object: "list",
    usage: { total_tokens: 4 },
  },
  "/multimodalembeddings": {
    data: [{ embedding: [0.1, 0.2], index: 0, object: "embedding" }],
    model: "voyage-multimodal-3.5",
    object: "list",
    usage: { total_tokens: 6 },
  },
  "/rerank": {
    data: [
      { document: "Paris is in France.", index: 1, relevance_score: 0.97 },
      { document: "Vienna is in Austria.", index: 0, relevance_score: 0.21 },
    ],
    model: "rerank-2.5",
    object: "list",
    usage: { total_tokens: 11 },
  },
  "/contextualizedembeddings": {
    data: [
      {
        data: [
          { embedding: [0.1, 0.2, 0.3, 0.4], index: 0, object: "embedding" },
          { embedding: [0.5, 0.6, 0.7, 0.8], index: 1, object: "embedding" },
        ],
        index: 0,
        object: "list",
      },
    ],
    model: "voyage-context-3",
    object: "list",
    usage: { total_tokens: 8 },
  },
};

function createVoyageAIFetch() {
  return async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const body = RESPONSES_BY_PATH[url.pathname];
    if (!body) {
      return new Response(JSON.stringify({ detail: "Not found" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      });
    }

    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };
}

export async function runVoyageAIInstrumentationScenario(
  voyageAI,
  { decorateClient } = {},
) {
  const baseClient = new voyageAI.VoyageAIClient({
    apiKey: "voyage-test-key",
    baseUrl: "https://api.voyage.test",
    fetch: createVoyageAIFetch(),
  });
  const client = decorateClient ? decorateClient(baseClient) : baseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("voyageai-embed-operation", "embed", async () => {
        const resultPromise = client.embed({
          input: ["Braintrust tracing"],
          inputType: "document",
          model: "voyage-4",
          outputDimension: 3,
        });
        if (typeof resultPromise.withRawResponse !== "function") {
          throw new Error("embed() did not preserve withRawResponse()");
        }
        await resultPromise;
      });

      await runOperation(
        "voyageai-multimodal-embed-operation",
        "multimodal-embed",
        async () => {
          await client.multimodalEmbed({
            inputs: [
              {
                content: [
                  { text: "A yellow banana.", type: "text" },
                  {
                    imageUrl: "https://example.com/banana.jpg",
                    type: "image_url",
                  },
                ],
              },
            ],
            inputType: "document",
            model: "voyage-multimodal-3.5",
          });
        },
      );

      await runOperation("voyageai-rerank-operation", "rerank", async () => {
        await client.rerank({
          documents: ["Vienna is in Austria.", "Paris is in France."],
          model: "rerank-2.5",
          query: "Which document is about France?",
          returnDocuments: true,
          topK: 2,
        });
      });

      await runOperation(
        "voyageai-contextualized-embed-operation",
        "contextualized-embed",
        async () => {
          await client.contextualizedEmbed({
            inputType: "document",
            inputs: [["Paris is a city.", "It is the capital of France."]],
            model: "voyage-context-3",
            outputDimension: 4,
          });
        },
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-voyageai-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedVoyageAIInstrumentation(voyageAI) {
  await runVoyageAIInstrumentationScenario(voyageAI, {
    decorateClient: wrapVoyageAI,
  });
}

export async function runAutoVoyageAIInstrumentation(voyageAI) {
  await runVoyageAIInstrumentationScenario(voyageAI);
}
