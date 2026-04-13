import { CohereClientV2 } from "cohere-sdk-v8";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoCohereInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoCohereInstrumentation(CohereClientV2, {
    apiVersion: "v8",
  }),
);
