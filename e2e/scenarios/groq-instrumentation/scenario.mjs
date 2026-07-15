const groqPackageName = process.env.GROQ_PACKAGE_NAME ?? "groq-sdk-v1-latest";
const { default: Groq } = await import(groqPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGroqInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  await runAutoGroqInstrumentation({
    Groq,
  });
});
