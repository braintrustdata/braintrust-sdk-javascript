import { wrapCohere } from "braintrust";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedCohereInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const cohere = await import(
    process.env.COHERE_PACKAGE_NAME ?? "cohere-sdk-v7-latest"
  );

  await runWrappedCohereInstrumentation(cohere.CohereClient, {
    apiVersion: "v7",
    decorateClient: wrapCohere,
    useV2Namespace: true,
  });
});
