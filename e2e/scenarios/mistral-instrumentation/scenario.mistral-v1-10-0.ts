import { Mistral } from "mistral-sdk-v1-10-0";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedMistralInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedMistralInstrumentation(Mistral));
