import type {
  BatchJob as BatchJobV1,
  CreateBatchJobParameters as CreateBatchJobParametersV1,
} from "google-genai-sdk-v1";
import type {
  BatchJob as BatchJobV2,
  CreateBatchJobParameters as CreateBatchJobParametersV2,
} from "google-genai-sdk-v2";
import {
  completeGeminiDeveloperBatchTrace,
  startGeminiDeveloperBatchTrace,
} from "braintrust";

declare const batchV1: BatchJobV1;
declare const batchV2: BatchJobV2;
declare const paramsV1: CreateBatchJobParametersV1;
declare const paramsV2: CreateBatchJobParametersV2;

void startGeminiDeveloperBatchTrace({ batch: batchV1, params: paramsV1 });
void completeGeminiDeveloperBatchTrace({ batch: batchV1, params: paramsV1 });
void startGeminiDeveloperBatchTrace({ batch: batchV2, params: paramsV2 });
void completeGeminiDeveloperBatchTrace({ batch: batchV2, params: paramsV2 });

const widenedParams = {
  model: "models/gemini-2.5-flash",
  src: { fileName: "files/input.jsonl" },
};
const widenedBatch = {
  dest: { fileName: "files/output.jsonl" },
  model: "models/gemini-2.5-flash",
  name: "batches/example",
};

void startGeminiDeveloperBatchTrace({
  batch: widenedBatch,
  params: widenedParams,
});
void completeGeminiDeveloperBatchTrace({
  batch: widenedBatch,
  params: widenedParams,
});
