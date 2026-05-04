import Groq from "groq-sdk";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedGroqInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runWrappedGroqInstrumentation({
    Groq,
  });
});
