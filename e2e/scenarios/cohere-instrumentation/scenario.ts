import { wrapCohere } from "braintrust";
import { CohereClientV2 } from "cohere-sdk-v8";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedCohereInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runWrappedCohereInstrumentation(CohereClientV2, {
    apiVersion: "v8",
    decorateClient: wrapCohere,
  }),
);
