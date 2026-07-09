import { wrapCohere } from "braintrust";
const coherePackageName =
  process.env.COHERE_PACKAGE_NAME ?? "cohere-sdk-v8-latest";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedCohereInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { CohereClientV2 } = await import(coherePackageName);
  await runWrappedCohereInstrumentation(CohereClientV2, {
    apiVersion: "v8",
    decorateClient: wrapCohere,
  });
});
