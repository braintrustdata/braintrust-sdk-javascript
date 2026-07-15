const groqPackageName = process.env.GROQ_PACKAGE_NAME ?? "groq-sdk-v1-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedGroqInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { default: Groq } = await import(groqPackageName);
  await runWrappedGroqInstrumentation({
    Groq,
  });
});
