import { CohereClient as CohereClientV7 } from "cohere-sdk-v7";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoCohereInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoCohereInstrumentation(CohereClientV7, {
    apiVersion: "v7",
  }),
);
