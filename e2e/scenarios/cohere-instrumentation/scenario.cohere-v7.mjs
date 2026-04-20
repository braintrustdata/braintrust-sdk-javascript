import {
  CohereClient as CohereClientV7,
  CohereClientV2 as CohereClientV7V2,
} from "cohere-sdk-v7";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoCohereInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoCohereInstrumentation(CohereClientV7, {
    apiVersion: "v7",
    ThinkingCohereClient:
      process.env.COHERE_SUPPORTS_THINKING === "1"
        ? CohereClientV7V2
        : undefined,
  }),
);
