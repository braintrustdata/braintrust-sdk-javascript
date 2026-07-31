import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoOllamaInstrumentation } from "./scenario.impl.mjs";

const ollamaPackageName =
  process.env.OLLAMA_PACKAGE_NAME ?? "ollama-v0-6-latest";

runMain(async () => {
  const { Ollama } = await import(ollamaPackageName);
  await runAutoOllamaInstrumentation(Ollama);
});
