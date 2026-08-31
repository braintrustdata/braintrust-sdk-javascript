import type {
  BatchJob as BatchJobV1,
  Batches as BatchesV1,
  CreateBatchJobParameters as CreateBatchJobParametersV1,
} from "google-genai-sdk-v1";
import type {
  BatchJob as BatchJobV2,
  Batches as BatchesV2,
  CreateBatchJobParameters as CreateBatchJobParametersV2,
} from "google-genai-sdk-v2";
import {
  completeGoogleGenAIBatchTrace,
  googleGenAIBatchesCreateTraced,
  googleGenAIBatchesGetTraced,
} from "braintrust";

declare const batchV1: BatchJobV1;
declare const batchV2: BatchJobV2;
declare const batchesV1: BatchesV1;
declare const batchesV2: BatchesV2;
declare const paramsV1: CreateBatchJobParametersV1;
declare const paramsV2: CreateBatchJobParametersV2;

void googleGenAIBatchesCreateTraced(batchesV1)(paramsV1);
void googleGenAIBatchesCreateTraced(batchesV2)(paramsV2);
void googleGenAIBatchesGetTraced(batchesV1)({ name: "batches/example" });
void googleGenAIBatchesGetTraced(batchesV2)({ name: "batches/example" });

const widenedBatch = {
  dest: { fileName: "files/output.jsonl" },
  model: "models/gemini-2.5-flash",
  name: "batches/example",
};

void completeGoogleGenAIBatchTrace({
  batch: widenedBatch,
  inputFileContent: '{"key":"one","request":{"contents":"Hi"}}',
  outputFileContent: '{"key":"one","response":{}}',
});
