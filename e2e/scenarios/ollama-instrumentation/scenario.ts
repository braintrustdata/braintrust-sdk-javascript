import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedOllamaInstrumentation } from "./scenario.impl.mjs";

const ollamaPackageName =
  process.env.OLLAMA_PACKAGE_NAME ?? "ollama-v0-6-latest";

runMain(async () => {
  const { Ollama } = await import(ollamaPackageName);
  await runWrappedOllamaInstrumentation(Ollama);
});
