import { Mistral } from "mistral-sdk-v1-10-0";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoMistralInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoMistralInstrumentation(Mistral));
