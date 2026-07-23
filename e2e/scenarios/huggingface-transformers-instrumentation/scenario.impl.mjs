import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "huggingface-transformers-instrumentation-root";
export const SCENARIO_NAME = "huggingface-transformers-instrumentation";
export const SCENARIO_TIMEOUT_MS = 90_000;
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

function tensor(sdk, type, values, dims) {
  const data =
    type === "float32"
      ? new Float32Array(values)
      : new BigInt64Array(values.map((value) => BigInt(value)));
  return new sdk.Tensor(type, data, dims);
}

function makeTokenizer(sdk) {
  const tokenizer = (texts, options = {}) => {
    if (options.text_pair !== undefined) {
      return {
        input_ids: tensor(sdk, "int64", [101, 200, 102, 300, 301, 102], [1, 6]),
        attention_mask: tensor(sdk, "int64", [1, 1, 1, 1, 1, 1], [1, 6]),
      };
    }

    const batchSize = Array.isArray(texts) ? texts.length : 1;
    return {
      input_ids: tensor(
        sdk,
        "int64",
        Array.from({ length: batchSize * 2 }, (_, index) => index + 1),
        [batchSize, 2],
      ),
      attention_mask: tensor(
        sdk,
        "int64",
        Array.from({ length: batchSize * 2 }, () => 1),
        [batchSize, 2],
      ),
    };
  };
  tokenizer.add_bos_token = false;
  tokenizer.add_eos_token = false;
  tokenizer.all_special_ids = [101, 102];
  tokenizer.sep_token_id = 102;
  tokenizer.batch_decode = (tokenIds) =>
    Array.from({ length: tokenIds.dims[0] }, () => "Deterministic output");
  tokenizer.decode = (tokenIds) =>
    tokenIds.some((value) => Number(value) === 300) ? "Ada" : "decoded";
  return tokenizer;
}

function makeGenerationModel(sdk, modelName) {
  return {
    config: {
      _name_or_path: modelName,
      model_type: "fixture",
    },
    generate: async () => tensor(sdk, "int64", [1, 2, 3], [1, 3]),
    dispose: async () => {},
  };
}

function makeFeatureModel(sdk, modelName) {
  return Object.assign(
    async () => ({
      last_hidden_state: tensor(sdk, "float32", [0.1, 0.2, 0.3], [1, 1, 3]),
    }),
    {
      config: {
        _name_or_path: modelName,
        model_type: "fixture",
      },
      dispose: async () => {},
    },
  );
}

function makeQuestionAnsweringModel(sdk, modelName) {
  return Object.assign(
    async () => ({
      start_logits: tensor(sdk, "float32", [0, 0, 0, 10, 0, 0], [1, 6]),
      end_logits: tensor(sdk, "float32", [0, 0, 0, 10, 0, 0], [1, 6]),
    }),
    {
      config: {
        _name_or_path: modelName,
        model_type: "fixture",
      },
      dispose: async () => {},
    },
  );
}

function createPipeline(sdk, task, modelName) {
  const tokenizer = makeTokenizer(sdk);
  switch (task) {
    case "text-generation":
      return new sdk.TextGenerationPipeline({
        task,
        model: makeGenerationModel(sdk, modelName),
        tokenizer,
      });
    case "text2text-generation":
      return new sdk.Text2TextGenerationPipeline({
        task,
        model: makeGenerationModel(sdk, modelName),
        tokenizer,
      });
    case "summarization":
      return new sdk.SummarizationPipeline({
        task,
        model: makeGenerationModel(sdk, modelName),
        tokenizer,
      });
    case "feature-extraction":
      return new sdk.FeatureExtractionPipeline({
        task,
        model: makeFeatureModel(sdk, modelName),
        tokenizer,
      });
    case "question-answering":
      return new sdk.QuestionAnsweringPipeline({
        task,
        model: makeQuestionAnsweringModel(sdk, modelName),
        tokenizer,
      });
    default:
      throw new Error(`Unsupported fixture task: ${task}`);
  }
}

export function withFixturePipelineFactory(sdk) {
  return {
    ...sdk,
    pipeline: async (task, model) =>
      createPipeline(sdk, task, model ?? `fixture/${task}`),
  };
}

export async function runScenario(sdk, options = {}) {
  const create =
    options.usePipelineFactory === true
      ? (task, model) => sdk.pipeline(task, model)
      : async (task, model) => createPipeline(sdk, task, model);

  await runTracedScenario({
    callback: async () => {
      const operations = [
        {
          task: "text-generation",
          args: ["Hello", { temperature: 0 }],
        },
        {
          task: "text2text-generation",
          args: ["Translate this"],
        },
        {
          task: "summarization",
          args: ["A deliberately long passage."],
        },
        {
          task: "feature-extraction",
          args: ["Embed this"],
        },
        {
          task: "question-answering",
          args: ["Who built it?", "Ada built it."],
        },
      ];

      for (const operation of operations) {
        await runOperation(
          `transformers-${operation.task}-operation`,
          operation.task,
          async () => {
            const pipeline = await create(
              operation.task,
              `fixture/${operation.task}`,
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
