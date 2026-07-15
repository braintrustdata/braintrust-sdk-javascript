const coherePackageName =
  process.env.COHERE_PACKAGE_NAME ?? "cohere-sdk-v8-latest";
const { CohereClientV2 } = await import(coherePackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoCohereInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoCohereInstrumentation(CohereClientV2, {
    apiVersion: "v8",
  }),
);
