import { Mistral } from "mistral-sdk-v1-3-4";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoMistralInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoMistralInstrumentation(Mistral, {
    supportsThinkingStream: false,
  }),
);
