import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "huggingface-transformers-instrumentation-root";
export const SCENARIO_NAME = "huggingface-transformers-instrumentation";
export const SCENARIO_TIMEOUT_MS = 90_000;
export const MODEL_IDS = {
  "feature-extraction": "onnx-internal-testing/tiny-random-BertModel-ONNX",
  "question-answering":
    "onnx-internal-testing/tiny-random-BertForQuestionAnswering-ONNX",
  summarization:
    "onnx-internal-testing/tiny-random-BartForConditionalGeneration-ONNX",
  "text-generation": "onnx-internal-testing/tiny-random-GPT2LMHeadModel-ONNX",
  "text2text-generation":
    "onnx-internal-testing/tiny-random-BartForConditionalGeneration-ONNX",
};
export const SCENARIO_SPECS = [
  {
    dependencyName: "huggingface-transformers-v3",
    snapshotName: "huggingface-transformers-v3",
  },
  {
    dependencyName: "huggingface-transformers-v3-latest",
    snapshotName: "huggingface-transformers-v3-latest",
  },
  {
    dependencyName: "huggingface-transformers-v4",
    snapshotName: "huggingface-transformers-v4",
  },
  {
    dependencyName: "huggingface-transformers-v4-latest",
    snapshotName: "huggingface-transformers-v4-latest",
  },
];

export function configureHuggingFaceHub(sdk) {
  process.env.HF_TOKEN ??= process.env.HUGGINGFACE_API_KEY;

  if (process.env.HF_ENDPOINT) {
    sdk.env.remoteHost = `${process.env.HF_ENDPOINT.replace(/\/$/, "")}/`;
  }

  const responses = new Map();
  sdk.env.allowLocalModels = false;
  sdk.env.useFSCache = false;
  sdk.env.useCustomCache = true;
  sdk.env.customCache = {
    async match(request) {
      const response = responses.get(
        typeof request === "string" ? request : request.url,
      );
      return response?.clone();
    },
    async put(request, response) {
      responses.set(
        typeof request === "string" ? request : request.url,
        response.clone(),
      );
    },
  };
}

export async function runScenario(sdk) {
  await runTracedScenario({
    callback: async () => {
      const operations = [
        {
          task: "text-generation",
          args: ["Hello", { do_sample: false, max_new_tokens: 2 }],
        },
        {
          task: "text2text-generation",
          args: [
            "Translate English to German: Hello",
            { do_sample: false, max_new_tokens: 3 },
          ],
        },
        {
          task: "summarization",
          args: [
            "A short passage about tracing.",
            { do_sample: false, max_new_tokens: 3 },
          ],
        },
        {
          task: "feature-extraction",
          args: ["Embed this", { normalize: true, pooling: "mean" }],
        },
        {
          task: "question-answering",
          args: ["Who wrote the program?", "Ada Lovelace wrote the program."],
        },
      ];

      for (const operation of operations) {
        await runOperation(
          `transformers-${operation.task}-operation`,
          operation.task,
          async () => {
            const pipeline = await sdk.pipeline(
              operation.task,
              MODEL_IDS[operation.task],
              { dtype: "fp32" },
            );
            await pipeline(...operation.args);
          },
        );
      }
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: SCENARIO_NAME,
    rootName: ROOT_NAME,
  });
}
