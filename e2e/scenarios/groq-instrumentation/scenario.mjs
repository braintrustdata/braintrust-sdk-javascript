import Groq from "groq-sdk";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGroqInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runAutoGroqInstrumentation({
    Groq,
  });
});
