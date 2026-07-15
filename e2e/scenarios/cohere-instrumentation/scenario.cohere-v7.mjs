import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoCohereInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const cohere = await import(
    process.env.COHERE_PACKAGE_NAME ?? "cohere-sdk-v7-latest"
  );

  await runAutoCohereInstrumentation(cohere.CohereClient, {
    apiVersion: "v7",
    useV2Namespace: true,
  });
});
