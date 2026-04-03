import { Mistral } from "mistral-sdk-v2";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedMistralInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedMistralInstrumentation(Mistral));
