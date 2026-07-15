const mistralPackageName = process.env.MISTRAL_PACKAGE_NAME ?? "mistral-sdk-v1";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedMistralInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { Mistral } = await import(mistralPackageName);
  await runWrappedMistralInstrumentation(Mistral, {
    supportsClassifiers: false,
    supportsClassify: false,
    supportsThinkingStream: false,
  });
});
