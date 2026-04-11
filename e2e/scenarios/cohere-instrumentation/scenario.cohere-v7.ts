import { wrapCohere } from "braintrust";
import { CohereClient as CohereClientV7 } from "cohere-sdk-v7";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedCohereInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runWrappedCohereInstrumentation(CohereClientV7, {
    apiVersion: "v7",
    decorateClient: wrapCohere,
  }),
);
