const mistralPackageName =
  process.env.MISTRAL_PACKAGE_NAME ?? "mistral-sdk-v1-latest";
const { Mistral } = await import(mistralPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoMistralInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoMistralInstrumentation(Mistral));
